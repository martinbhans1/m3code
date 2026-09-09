#!/usr/bin/env node
// @effect-diagnostics globalDate:off - Standalone watchdog process, no Effect runtime.
/**
 * watchdog-rehearsal - Stage the night the watchdog exists for, on demand.
 *
 * The watchdog's most load-bearing claim is an ordering one: when a limit
 * lifts, the supervising conversation is woken first, one conversation at a
 * time, and separate accounts recover in parallel. Waiting for a real usage
 * limit to prove that means never proving it.
 *
 * So this takes a consistent copy of the live store, plants a stalled
 * supervisor and two stalled workers in it, and runs the real scan against the
 * copy several times over - the actual command the scheduler runs, reading real
 * projections, writing real receipts. Nothing is ever sent: the copy is a
 * throwaway directory, and delivery is simulated so the sequence can advance.
 *
 * It checks its own expectations and exits non-zero when they are not met, so
 * it is worth re-running after any change to the decision rules.
 */
// @effect-diagnostics nodeBuiltinImport:off - must run standalone of the app runtime
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { readJsonFile, readLedger, watchdogPaths } from "./lib/watchdog-store.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_SCRIPT = join(REPO_ROOT, "scripts", "usage-limit-watchdog.ts");
const live = watchdogPaths();

/** Everything the rehearsal creates lives here, and is inspectable afterwards. */
const sandboxRoot = join(live.root, "rehearsals", new Date().toISOString().replaceAll(":", "-"));
const sandbox = watchdogPaths(sandboxRoot);

function step(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** The tables the watchdog reads, in an order that satisfies nothing but readability. */
const COPIED_TABLES = [
  "projection_projects",
  "projection_threads",
  "projection_thread_sessions",
  "projection_turns",
  "projection_thread_activities",
] as const;

/**
 * Build the sandbox store from the live one.
 *
 * The schema is copied verbatim from the running app - that is the whole point,
 * because a renamed column is exactly the drift that would break the watchdog
 * silently. The rows are not: copying the lot means five gigabytes and two
 * minutes per rehearsal, so only the conversations the watchdog would actually
 * look at come across, which is the handful whose newest turn failed.
 */
function buildSandboxStore(): number {
  mkdirSync(sandbox.stateDir, { recursive: true });
  const source = new DatabaseSync(live.databaseFile, { readOnly: true });
  const target = new DatabaseSync(sandbox.databaseFile);
  try {
    for (const table of COPIED_TABLES) {
      const definition = source
        .prepare("select sql from sqlite_master where type = 'table' and name = ?")
        .get(table) as { readonly sql: string } | undefined;
      if (!definition) throw new Error(`The live store has no ${table}; the watchdog needs it.`);
      target.exec(definition.sql);
    }

    const stalled = source
      .prepare(
        `select t.thread_id as threadId
           from projection_threads t
           join projection_turns lt
             on lt.row_id = (select max(row_id) from projection_turns where thread_id = t.thread_id)
          where t.deleted_at is null and t.archived_at is null and lt.state = 'error'`,
      )
      .all() as readonly unknown[] as readonly { readonly threadId: string }[];
    const threadIds = stalled.map((row) => row.threadId);
    const placeholders = threadIds.map(() => "?").join(", ");

    const copy = (table: string, where: string, parameters: readonly string[]) => {
      const rows = source.prepare(`select * from ${table} ${where}`).all(...parameters) as readonly Record<
        string,
        unknown
      >[];
      if (rows.length === 0) return;
      const columns = Object.keys(rows[0] as Record<string, unknown>);
      const insert = target.prepare(
        `insert or replace into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
      );
      for (const row of rows) {
        insert.run(...columns.map((column) => row[column] as null));
      }
    };

    copy("projection_projects", "", []);
    if (threadIds.length > 0) {
      for (const table of [
        "projection_threads",
        "projection_thread_sessions",
        "projection_turns",
        "projection_thread_activities",
      ]) {
        copy(table, `where thread_id in (${placeholders})`, threadIds);
      }
    }
    return threadIds.length;
  } finally {
    source.close();
    target.close();
  }
}

function copyRuntimeFiles(): void {
  for (const file of [live.serverRuntimeFile, live.settingsFile]) {
    const name = file.slice(Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/")) + 1);
    copyFileSync(file, join(sandbox.stateDir, name));
  }
}

/** The provider's own wording, naming a reset that has just gone by. */
function limitMessageFor(resetAt: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Oslo",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(resetAt);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `You've hit your session limit \u00b7 resets ${read("hour")}:${read("minute")}${read("dayPeriod").toLowerCase()} (Europe/Oslo)`;
}

interface PlantedThread {
  readonly threadId: string;
  readonly title: string;
  readonly projectId: string;
  readonly providerInstanceId: string;
  readonly failedAt: Date;
}

function plantStalledConversations(now: Date): readonly PlantedThread[] {
  const settings = readJsonFile<{ orchestratorProjectId?: string }>(
    join(sandbox.stateDir, "settings.json"),
  );
  const orchestratorProjectId = settings?.orchestratorProjectId;
  if (!orchestratorProjectId) {
    throw new Error("No orchestrator project is configured, so there is no supervisor to rehearse.");
  }

  const database = new DatabaseSync(sandbox.databaseFile);
  const workerProjectId = "rehearsal-project";
  database
    .prepare(
      `insert or replace into projection_projects
         (project_id, title, workspace_root, scripts_json, created_at, updated_at)
       values (?, 'REHEARSAL workers', 'C:/rehearsal', '[]', ?, ?)`,
    )
    .run(workerProjectId, now.toISOString(), now.toISOString());

  const resetAt = new Date(now.getTime() - 10 * 60_000);
  const planted: PlantedThread[] = [
    {
      threadId: "rehearsal-supervisor",
      title: "REHEARSAL supervisor",
      projectId: orchestratorProjectId,
      providerInstanceId: "claudeAgent",
      failedAt: new Date(now.getTime() - 40 * 60_000),
    },
    {
      threadId: "rehearsal-worker-claude",
      title: "REHEARSAL worker on the same account",
      projectId: workerProjectId,
      providerInstanceId: "claudeAgent",
      failedAt: new Date(now.getTime() - 45 * 60_000),
    },
    {
      threadId: "rehearsal-worker-codex",
      title: "REHEARSAL worker on a different account",
      projectId: workerProjectId,
      providerInstanceId: "codex",
      failedAt: new Date(now.getTime() - 50 * 60_000),
    },
  ];

  for (const thread of planted) {
    const failedAt = thread.failedAt.toISOString();
    database
      .prepare(
        `insert or replace into projection_threads
           (thread_id, project_id, title, created_at, updated_at, latest_turn_id,
            latest_user_message_at, runtime_mode, interaction_mode, model_selection_json)
         values (?, ?, ?, ?, ?, ?, ?, 'full-access', 'default', ?)`,
      )
      .run(
        thread.threadId,
        thread.projectId,
        thread.title,
        failedAt,
        failedAt,
        `${thread.threadId}-turn`,
        new Date(thread.failedAt.getTime() - 60 * 60_000).toISOString(),
        JSON.stringify({ instanceId: thread.providerInstanceId, model: "claude-opus-5" }),
      );
    database
      .prepare(
        `insert into projection_turns
           (thread_id, turn_id, state, requested_at, started_at, completed_at, checkpoint_files_json)
         values (?, ?, 'error', ?, ?, ?, '[]')`,
      )
      .run(
        thread.threadId,
        `${thread.threadId}-turn`,
        new Date(thread.failedAt.getTime() - 20 * 60_000).toISOString(),
        new Date(thread.failedAt.getTime() - 20 * 60_000).toISOString(),
        failedAt,
      );
    database
      .prepare(
        `insert or replace into projection_thread_sessions
           (thread_id, status, provider_name, provider_instance_id, last_error, updated_at, runtime_mode)
         values (?, 'stopped', 'claudeAgent', ?, ?, ?, 'full-access')`,
      )
      .run(thread.threadId, thread.providerInstanceId, limitMessageFor(resetAt), failedAt);
    database
      .prepare(
        `insert or replace into projection_thread_activities
           (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
         values (?, ?, ?, 'error', 'runtime.error', 'Runtime error', ?, ?)`,
      )
      .run(
        `${thread.threadId}-error`,
        thread.threadId,
        `${thread.threadId}-turn`,
        JSON.stringify({ message: limitMessageFor(resetAt) }),
        failedAt,
      );
  }
  database.close();
  return planted;
}

/** Give a conversation a heartbeat, the way a real restart would. */
function showLife(threadId: string, at: Date): void {
  const database = new DatabaseSync(sandbox.databaseFile);
  database
    .prepare(
      `insert or replace into projection_thread_activities
         (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
       values (?, ?, ?, 'info', 'context-window.updated', 'Context window updated', '{}', ?)`,
    )
    .run(`${threadId}-life`, threadId, `${threadId}-turn`, at.toISOString());
  database.close();
}

interface LatestScan {
  readonly scanId: string;
  readonly action: { readonly kind: string; readonly threadId?: string; readonly reason?: string };
}

function runScan(): LatestScan {
  execFileSync(process.execPath, ["--no-warnings", SCAN_SCRIPT, "scan", "--simulate"], {
    env: { ...process.env, T3CODE_HOME: sandboxRoot },
    stdio: "pipe",
    windowsHide: true,
    encoding: "utf-8",
  });
  const latest = readJsonFile<LatestScan>(sandbox.latestScanFile);
  if (!latest) throw new Error("The scan left no record behind.");
  return latest;
}

const failures: string[] = [];
function expect(label: string, actual: string, wanted: string): void {
  const ok = actual === wanted;
  if (!ok) failures.push(`${label}: wanted ${wanted}, got ${actual}`);
  step(`  ${ok ? "as expected" : "UNEXPECTED"} - ${label}: ${actual}`);
}

function describe(scan: LatestScan): string {
  return scan.action.kind === "nudge"
    ? `nudged ${scan.action.threadId ?? "?"}`
    : `held (${scan.action.reason ?? "?"})`;
}

const now = new Date();
step(`Rehearsal sandbox: ${sandboxRoot}`);
const carriedOver = buildSandboxStore();
copyRuntimeFiles();
step(
  `Copied the live schema and the ${carriedOver} conversation(s) the watchdog would look at today.`,
);
const planted = plantStalledConversations(now);
step(
  `Planted ${planted.length} conversations stopped by a usage limit that lifted ten minutes ago:`,
);
for (const thread of planted) step(`  ${thread.title} (${thread.providerInstanceId})`);

step("\nScan 1 - everything is stalled, nothing has been woken yet.");
expect("first conversation woken", describe(runScan()), "nudged rehearsal-supervisor");

step("\nScan 2 - the supervisor has not stirred yet.");
expect(
  "second conversation woken",
  describe(runScan()),
  "nudged rehearsal-worker-codex",
);

step("\nScan 3 - both accounts are now waiting on a conversation that has not stirred.");
const third = runScan();
expect("third scan", third.action.kind, "none");

step("\nThe supervisor wakes up.");
showLife("rehearsal-supervisor", new Date());
step("Scan 4 - its account is free again.");
expect("fourth conversation woken", describe(runScan()), "nudged rehearsal-worker-claude");

const ledger = readLedger(sandbox).entries;
step("\nWhat the ledger recorded, in order:");
for (const entry of ledger) {
  step(`  ${entry.at} ${entry.threadTitle} (${entry.providerInstanceId}) attempt ${entry.attempt}`);
}
const nudgedTwice = ledger.filter(
  (entry, index) => ledger.findIndex((other) => other.threadId === entry.threadId) !== index,
);
expect("conversations woken more than once", String(nudgedTwice.length), "0");

if (failures.length > 0) {
  process.stderr.write(`\nRehearsal FAILED:\n${failures.map((line) => `  ${line}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  step("\nRehearsal passed. Receipts and scan records are under the sandbox above.");
  if (process.argv.includes("--keep")) {
    step("Sandbox kept.");
  } else {
    rmSync(sandboxRoot, { recursive: true, force: true });
    step("Sandbox removed; re-run with --keep to inspect the files.");
  }
}
