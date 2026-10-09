// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off globalDate:off unsafeEffectTypeAssertion:off - standalone benchmark script measuring the raw event loop.
/**
 * Event-loop responsiveness benchmark for conversation search and its
 * background semantic indexer, run against an isolated copy of a real database.
 *
 *   node apps/server/scripts/conversation-search-bench.ts prepare <snapshot.sqlite> <workDir>
 *   node apps/server/scripts/conversation-search-bench.ts run <workDir> <label> [implementation.ts]
 *   node apps/server/scripts/conversation-search-bench.ts compare <workDir> <labelA> <labelB>
 *
 * The implementation to compare against is any copy of ConversationSearch.ts,
 * e.g. `git show <rev>:apps/server/src/conversationSearch/ConversationSearch.ts`
 * saved next to it with its service key renamed so both can load.
 *
 * `prepare` builds a slim database holding only what search reads (projects,
 * threads, messages, the semantic index) with the server's own migrations, so
 * triggers and FTS tables are exactly as in production. Take the snapshot with
 * `VACUUM INTO` from a read-only connection; never point this at a live file.
 *
 * `run` copies that database, appends messages to the longest recent threads the
 * way a live conversation does, and measures while the indexer catches up:
 * - the longest event-loop freezes, from a 5ms heartbeat timer;
 * - how long a title search takes to answer, sampled every 250ms;
 * - how long a semantic search takes, and whether it came back with results.
 * Final index rows and search results are dumped for `compare`.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync, StatementSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../src/config.ts";
import { runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import * as SqliteReadWorker from "../src/persistence/SqliteReadWorker.ts";

const ACTIVE_THREADS = 3;
const LIVE_SECONDS = Number(process.env.BENCH_LIVE_SECONDS ?? 45);
const APPEND_EVERY_MS = 3_000;
const TITLE_PROBE_EVERY_MS = 250;
const SEMANTIC_PROBE_EVERY_MS = 2_000;
const FINAL_QUERIES = [
  { query: "status", titlesOnly: true },
  { query: "search slow", titlesOnly: true },
  { query: "status", includeSemantic: false },
  { query: "fix the conversation search performance", includeSemantic: true },
  { query: "how do we handle invoices from tripletex", includeSemantic: true },
  { query: "theme colors aurora background", includeSemantic: true },
];
const APPENDED_TEXT =
  "Follow-up on the work above: I checked the indexer, the search results, and the " +
  "background worker. ".repeat(14);

const [command, ...args] = process.argv.slice(2);

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function summarize(values: number[]) {
  return {
    n: values.length,
    p50: Math.round(percentile(values, 0.5)),
    p95: Math.round(percentile(values, 0.95)),
    max: Math.round(Math.max(0, ...values)),
  };
}

async function prepare(snapshotPath: string, workDir: string) {
  mkdirSync(workDir, { recursive: true });
  const target = join(workDir, "base.sqlite");
  if (existsSync(target)) throw new Error(`${target} already exists.`);
  await Effect.runPromise(
    runMigrations().pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: target })),
    ) as Effect.Effect<unknown>,
  );
  const db = new DatabaseSync(target);
  db.exec(`ATTACH DATABASE '${resolve(snapshotPath).replaceAll("'", "''")}' AS snap`);
  db.exec("BEGIN");
  for (const table of [
    "projection_projects",
    "projection_threads",
    "projection_thread_messages",
    "conversation_search_semantic_state",
    "conversation_search_semantic_chunks",
  ]) {
    db.exec(`DELETE FROM main.${table}`);
    db.exec(`INSERT INTO main.${table} SELECT * FROM snap.${table}`);
  }
  // Inserting the copies fired the dirty-thread triggers; the copied index is
  // the indexer's real starting point, so start clean, as the live app is.
  db.exec("DELETE FROM main.conversation_search_semantic_dirty_threads");
  db.exec("DELETE FROM main.conversation_search_semantic_processing_threads");
  db.exec("COMMIT");
  db.exec("DETACH DATABASE snap");
  const counts = db
    .prepare(
      `SELECT
        (SELECT count(*) FROM projection_threads) AS threads,
        (SELECT count(*) FROM projection_thread_messages) AS messages,
        (SELECT count(*) FROM conversation_search_semantic_chunks) AS chunks`,
    )
    .get();
  db.exec("VACUUM");
  db.close();
  console.log("prepared", target, counts);
}

async function run(workDir: string, label: string, implementation: string) {
  const runDir = join(workDir, label);
  mkdirSync(join(runDir, "caches"), { recursive: true });
  const dbPath = join(runDir, "state.sqlite");
  copyFileSync(join(workDir, "base.sqlite"), dbPath);
  // The server always runs in WAL mode (persistence/Layers/Sqlite.ts). Without
  // it a reader and a writer lock each other out, which is not what ships.
  const walSetup = new DatabaseSync(dbPath);
  walSetup.exec("PRAGMA journal_mode = WAL");
  walSetup.close();
  const models = join(workDir, "caches", "conversation-search-models");
  if (!existsSync(models)) throw new Error(`Copy the embedding model cache to ${models} first.`);

  const module = (await import(
    pathToFileURL(resolve(implementation)).href
  )) as typeof import("../src/conversationSearch/ConversationSearch.ts");

  // Which statements the event loop spends its time in: every node:sqlite call
  // is synchronous, so its duration is exactly how long it blocked the server.
  // Only the live and catch-up phases count; the harness's own setup and
  // result-collection queries are not the server's doing.
  let measuring = false;
  const sqlTime = new Map<string, { calls: number; ms: number; max: number }>();
  for (const method of ["all", "get", "run"] as const) {
    const original = StatementSync.prototype[method] as (...params: unknown[]) => unknown;
    (StatementSync.prototype as unknown as Record<string, unknown>)[method] = function (
      this: StatementSync,
      ...params: unknown[]
    ) {
      const start = performance.now();
      try {
        return original.apply(this, params);
      } finally {
        const ms = performance.now() - start;
        if (measuring) {
          const key = this.sourceSQL.replace(/\s+/g, " ").trim().slice(0, 100);
          const entry = sqlTime.get(key) ?? { calls: 0, ms: 0, max: 0 };
          entry.calls += 1;
          entry.ms += ms;
          entry.max = Math.max(entry.max, ms);
          sqlTime.set(key, entry);
        }
      }
    };
  }

  // The heartbeat: any gap well past 5ms is time the event loop could not run.
  const gaps: number[] = [];
  let last = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    if (measuring) gaps.push(now - last - 5);
    last = now;
  }, 5);

  const program = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA busy_timeout = 5000`;
    const config = yield* ServerConfig;
    yield* Effect.promise(() =>
      import("node:fs/promises").then((fs) =>
        fs.cp(models, join(config.providerStatusCacheDir, "conversation-search-models"), {
          recursive: true,
        }),
      ),
    );
    const maxRowid = (yield* sql<{ value: number }>`
      SELECT COALESCE(max(rowid), 0) AS value FROM conversation_search_semantic_chunks
    `)[0]!.value;
    // The live case: the most recently active conversations, longest first.
    const active = yield* sql<{ threadId: string; chunks: number }>`
      SELECT thread.thread_id AS "threadId", count(chunk.chunk_id) AS chunks
      FROM projection_threads AS thread
      JOIN conversation_search_semantic_chunks AS chunk ON chunk.thread_id = thread.thread_id
      WHERE thread.deleted_at IS NULL
      GROUP BY thread.thread_id
      ORDER BY thread.updated_at DESC
      LIMIT 40
    `;
    const targets = active.toSorted((a, b) => b.chunks - a.chunks).slice(0, ACTIVE_THREADS);
    let appended = 0;
    const append = Effect.forEach(
      targets,
      (target) => {
        appended += 1;
        const at = new Date(Date.UTC(2030, 0, 1, 0, 0, appended)).toISOString();
        return sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, attachments_json,
            is_streaming, created_at, updated_at
          ) VALUES (
            ${`bench-${label}-${appended}`}, ${target.threadId}, NULL, 'assistant',
            ${`${APPENDED_TEXT} (${appended})`}, NULL, 0, ${at}, ${at}
          )
        `;
      },
      { discard: true },
    );

    const search = yield* module.ConversationSearch;
    const titleLatency: number[] = [];
    const semanticLatency: number[] = [];
    let semanticWithResults = 0;
    const timed = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const start = performance.now();
        const result = yield* effect;
        return { result, ms: performance.now() - start };
      });
    const titleProbe = Effect.forever(
      timed(search.search({ query: "status", titlesOnly: true })).pipe(
        Effect.tap(({ ms }) => Effect.sync(() => titleLatency.push(ms))),
        Effect.andThen(Effect.sleep(`${TITLE_PROBE_EVERY_MS} millis`)),
      ),
    );
    const semanticProbe = Effect.forever(
      timed(search.search({ query: "speed up the search indexer", includeSemantic: true })).pipe(
        Effect.tap(({ ms, result }) =>
          Effect.sync(() => {
            semanticLatency.push(ms);
            if (
              result.results.some(
                (row) => row.matchKind === "semantic" || row.matchKind === "hybrid",
              )
            )
              semanticWithResults += 1;
          }),
        ),
        Effect.andThen(Effect.sleep(`${SEMANTIC_PROBE_EVERY_MS} millis`)),
      ),
    );
    const pendingThreads = sql<{ value: number }>`
      SELECT
        (SELECT count(*) FROM conversation_search_semantic_dirty_threads)
        + (SELECT count(*) FROM conversation_search_semantic_processing_threads) AS value
    `.pipe(Effect.map((rows) => rows[0]!.value));

    measuring = true;
    last = performance.now();
    const started = performance.now();
    const probes = yield* Effect.forkChild(
      Effect.all([titleProbe, semanticProbe], { concurrency: 2 }),
    );
    const liveUntil = performance.now() + LIVE_SECONDS * 1000;
    while (performance.now() < liveUntil) {
      yield* append;
      yield* Effect.sleep(`${APPEND_EVERY_MS} millis`);
    }
    const liveEnded = performance.now();
    // Then let the indexer drain whatever the live phase left behind.
    let finalStatus = "indexing";
    while (true) {
      finalStatus = (yield* search.search({ query: "x y" })).semanticStatus;
      if (finalStatus === "unavailable") break;
      if (finalStatus === "ready" && (yield* pendingThreads) === 0) break;
      yield* Effect.sleep("200 millis");
    }
    const drained = performance.now();
    measuring = false;
    yield* Fiber.interrupt(probes);

    const embedded = (yield* sql<{ value: number }>`
      SELECT count(*) AS value FROM conversation_search_semantic_chunks WHERE rowid > ${maxRowid}
    `)[0]!.value;
    const finalRows = yield* sql<{ chunkId: string; text: string; embedding: Uint8Array }>`
      SELECT chunk_id AS "chunkId", text, embedding
      FROM conversation_search_semantic_chunks
      WHERE thread_id IN ${sql.in(targets.map((target) => target.threadId))}
      ORDER BY chunk_id
    `;
    const finalResults = [];
    for (const input of FINAL_QUERIES) {
      const result = yield* search.search(input);
      finalResults.push({
        input,
        threads: result.results.map((row) => `${row.threadId}:${row.matchKind}`),
      });
    }
    return {
      finalStatus,
      targets,
      appended,
      embeddedChunks: embedded,
      liveSeconds: (liveEnded - started) / 1000,
      drainSeconds: (drained - liveEnded) / 1000,
      titleLatency,
      semanticLatency,
      semanticWithResults,
      finalRows: finalRows.map((row) => ({
        chunkId: row.chunkId,
        text: row.text,
        embedding: Array.from(new Float32Array(new Uint8Array(row.embedding).buffer)),
      })),
      finalResults,
    };
  });

  const layer = Layer.mergeAll(module.ConversationSearchLive).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath })),
    // Wired as the server wires it; implementations that do not ask for a
    // reader simply never start the worker.
    Layer.provideMerge(SqliteReadWorker.layer({ filename: dbPath })),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), runDir).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
  const result = (await Effect.runPromise(
    Effect.scoped(program.pipe(Effect.provide(layer))) as never,
  )) as Awaited<ReturnType<typeof Effect.runPromise<any, any>>>;
  clearInterval(heartbeat);

  const stalls = gaps.filter((gap) => gap > 50);
  const report = {
    label,
    implementation,
    semanticStatusAtEnd: result.finalStatus,
    targets: result.targets,
    appendedMessages: result.appended,
    embeddedChunks: result.embeddedChunks,
    liveSeconds: Number(result.liveSeconds.toFixed(1)),
    drainSeconds: Number(result.drainSeconds.toFixed(1)),
    eventLoop: {
      longestFreezeMs: Math.round(Math.max(0, ...gaps)),
      freezesOver50ms: stalls.length,
      frozenSecondsTotal: Number((stalls.reduce((sum, gap) => sum + gap, 0) / 1000).toFixed(1)),
      gapP99Ms: Math.round(percentile(gaps, 0.99)),
    },
    titleSearchMs: summarize(result.titleLatency),
    semanticSearchMs: summarize(result.semanticLatency),
    semanticSearchesWithSemanticHits: `${result.semanticWithResults}/${result.semanticLatency.length}`,
    slowestStatements: [...sqlTime]
      .toSorted((a, b) => b[1].ms - a[1].ms)
      .slice(0, 8)
      .map(([statement, entry]) => ({
        statement,
        calls: entry.calls,
        totalMs: Math.round(entry.ms),
        maxMs: Math.round(entry.max),
      })),
  };
  writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(
    join(runDir, "final.json"),
    JSON.stringify({ rows: result.finalRows, results: result.finalResults }),
  );
  console.log(JSON.stringify(report, null, 2));
}

function compare(workDir: string, labelA: string, labelB: string) {
  const read = (label: string) =>
    JSON.parse(readFileSync(join(workDir, label, "final.json"), "utf8")) as {
      rows: { chunkId: string; text: string; embedding: number[] }[];
      results: { input: unknown; threads: string[] }[];
    };
  const a = read(labelA);
  const b = read(labelB);
  const byId = new Map(b.rows.map((row) => [row.chunkId, row] as const));
  let maxDiff = 0;
  const mismatched: string[] = [];
  for (const row of a.rows) {
    const other = byId.get(row.chunkId);
    if (!other || other.text !== row.text) {
      mismatched.push(row.chunkId);
      continue;
    }
    for (let i = 0; i < row.embedding.length; i += 1)
      maxDiff = Math.max(maxDiff, Math.abs(row.embedding[i]! - other.embedding[i]!));
  }
  console.log({
    chunksA: a.rows.length,
    chunksB: b.rows.length,
    idsOrTextMismatched: mismatched.length + Math.abs(a.rows.length - b.rows.length),
    maxEmbeddingDifference: maxDiff,
  });
  a.results.forEach((result, index) => {
    const other = b.results[index]!;
    const same = JSON.stringify(result.threads) === JSON.stringify(other.threads);
    console.log(
      same ? "same     " : "DIFFERENT",
      JSON.stringify(result.input),
      result.threads.length,
    );
  });
}

if (command === "prepare") await prepare(args[0]!, args[1]!);
else if (command === "run")
  await run(
    args[0]!,
    args[1]!,
    args[2] ?? "apps/server/src/conversationSearch/ConversationSearch.ts",
  );
else if (command === "compare") compare(args[0]!, args[1]!, args[2]!);
else {
  console.error(
    "usage: prepare <snapshot> <workDir> | run <workDir> <label> [impl] | compare <workDir> <a> <b>",
  );
  process.exitCode = 1;
}
