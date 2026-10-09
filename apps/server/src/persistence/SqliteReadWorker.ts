/**
 * A read-only SQLite connection on a worker thread, exposed as an ordinary
 * `SqlClient`.
 *
 * `node:sqlite` is synchronous, so every statement on the server's main
 * connection holds the event loop for as long as SQLite takes. For a point
 * lookup that is nothing; for a scan over message text it is hundreds of
 * milliseconds to seconds, during which no request, socket ping or provider
 * event is handled. Heavy reads that do not need to see their own writes can
 * run here instead and the server keeps answering while they do.
 *
 * Reads only. The connection is opened `readOnly`, so nothing sent here can
 * change the database, and writes keep their single connection and transaction
 * semantics on the main thread. WAL mode lets this connection read alongside it;
 * a statement sees whatever was committed when it started.
 *
 * The worker is evaluated from source so the bundler has nothing to resolve: it
 * needs only Node built-ins.
 */
import { Worker } from "node:worker_threads";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.filename, { readOnly: true });
db.exec("PRAGMA busy_timeout = 5000");
const statements = new Map();
const prepare = (sql) => {
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
    if (statements.size > 200) statements.delete(statements.keys().next().value);
  }
  return statement;
};
parentPort.on("message", ({ id, sql, params, arrays }) => {
  try {
    const statement = prepare(sql);
    statement.setReturnArrays(arrays);
    parentPort.postMessage({ id, ok: true, rows: statement.all(...params) });
  } catch (cause) {
    parentPort.postMessage({
      id,
      ok: false,
      message: String(cause?.message ?? cause),
      code: cause?.code,
      errcode: cause?.errcode,
      errstr: cause?.errstr,
    });
  }
});
`;

type WorkerReply =
  | { readonly id: number; readonly ok: true; readonly rows: ReadonlyArray<any> }
  | {
      readonly id: number;
      readonly ok: false;
      readonly message: string;
      readonly code?: string;
      readonly errcode?: number;
      readonly errstr?: string;
    };

interface PendingQuery {
  readonly resolve: (rows: ReadonlyArray<any>) => void;
  readonly reject: (cause: unknown) => void;
}

/**
 * Optional service: where heavy read-only queries should go. Absent (tests,
 * in-memory databases, the Bun runtime) means "use the main `SqlClient`".
 */
export class SqliteReader extends Context.Service<SqliteReader, Client.SqlClient>()(
  "t3/persistence/SqliteReadWorker/SqliteReader",
) {}

/** The read client to use: the worker reader when one is configured, else `fallback`. */
export const readerOr = (fallback: Client.SqlClient) =>
  Effect.map(Effect.serviceOption(SqliteReader), (reader) =>
    reader._tag === "Some" ? reader.value : fallback,
  );

function makeWorkerConnection(filename: string) {
  const pending = new Map<number, PendingQuery>();
  let worker: Worker | null = null;
  let nextId = 0;

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    const created = new Worker(WORKER_SOURCE, { eval: true, workerData: { filename } });
    created.unref();
    created.on("message", (reply: WorkerReply) => {
      const query = pending.get(reply.id);
      if (!query) return;
      pending.delete(reply.id);
      if (reply.ok) {
        query.resolve(reply.rows);
      } else {
        query.reject(
          Object.assign(new Error(reply.message), {
            code: reply.code,
            errcode: reply.errcode,
            errstr: reply.errstr,
          }),
        );
      }
    });
    // A dead worker fails what it was holding; the next query starts a new one.
    const onDeath = (cause: unknown) => {
      if (worker !== created) return;
      worker = null;
      for (const query of pending.values()) query.reject(cause);
      pending.clear();
    };
    created.on("error", onDeath);
    created.on("exit", (code) =>
      onDeath(new Error(`SQLite read worker exited with code ${code}.`)),
    );
    worker = created;
    return created;
  };

  const query = (sql: string, params: ReadonlyArray<unknown>, arrays: boolean) =>
    Effect.tryPromise({
      try: () =>
        new Promise<ReadonlyArray<any>>((resolve, reject) => {
          nextId += 1;
          pending.set(nextId, { resolve, reject });
          ensureWorker().postMessage({ id: nextId, sql, params, arrays });
        }),
      catch: (cause) =>
        new SqlError({
          reason: classifySqliteError(cause, {
            message: "Failed to execute statement on the read worker",
            operation: "execute",
          }),
        }),
    });

  const connection: Connection = {
    execute: (sql, params, transformRows) =>
      transformRows
        ? Effect.map(query(sql, params, false), transformRows)
        : query(sql, params, false),
    executeRaw: (sql, params) => query(sql, params, false),
    executeValues: (sql, params) => query(sql, params, true),
    executeUnprepared: (sql, params, transformRows) =>
      transformRows
        ? Effect.map(query(sql, params, false), transformRows)
        : query(sql, params, false),
    executeStream: () => Stream.die("executeStream not implemented"),
  };

  const close = Effect.promise(async () => {
    const current = worker;
    worker = null;
    for (const query of pending.values()) query.reject(new Error("SQLite read worker closed."));
    pending.clear();
    await current?.terminate();
  });

  return { connection, close };
}

const make = (options: {
  readonly filename: string;
  readonly spanAttributes?: Record<string, unknown> | undefined;
}) =>
  Effect.gen(function* () {
    const { connection, close } = makeWorkerConnection(options.filename);
    yield* Effect.addFinalizer(() => close);
    const acquirer = Effect.succeed(connection);
    return yield* Client.make({
      acquirer,
      // A transaction here could only ever be a read snapshot, and nothing needs
      // one; refusing keeps "writes happen on the main connection" a guarantee.
      transactionAcquirer: Effect.die(
        new Error("The SQLite read worker does not run transactions; use the main SqlClient."),
      ),
      compiler: Statement.makeCompilerSqlite(),
      spanAttributes: [
        ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
        ["db.system.name", "sqlite"],
        ["db.connection", "read-worker"],
      ],
    });
  });

export const layer = (options: {
  readonly filename: string;
  readonly spanAttributes?: Record<string, unknown> | undefined;
}): Layer.Layer<SqliteReader> =>
  Layer.effect(SqliteReader, make(options)).pipe(Layer.provide(Reactivity.layer));
