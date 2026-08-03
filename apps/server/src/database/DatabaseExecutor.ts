/**
 * DatabaseExecutor — runs SQL against a configured project database.
 *
 * Backs the "Run SQL" action in the file preview panel. Connections come from
 * `ServerSettings.databaseConnections`; the settings service has already
 * materialized the connection string out of the secret store by the time we
 * read it here.
 *
 * Execution semantics: the whole file is submitted as a single simple-query
 * message. Postgres wraps a multi-statement simple query in an implicit
 * transaction, so a migration script usually applies completely or not at all.
 *
 * That guarantee is NOT absolute, and the UI must not claim it is: per the
 * Postgres protocol docs, a `COMMIT` or `ROLLBACK` inside the message closes
 * the block and any following statements run in a *fresh* implicit
 * transaction. So `BEGIN; …; COMMIT; …;` — the shape of most hand-written
 * migrations — can be left half-applied. It also means statements that cannot
 * run inside a transaction block (`CREATE INDEX CONCURRENTLY`, `VACUUM`) fail
 * whenever the file holds more than one statement, even though `psql -f` on
 * the same file succeeds. `hasExplicitTransactionControl` in the web client
 * detects the first case and downgrades the copy accordingly.
 *
 * Known limitation: results are fully buffered by `pg` before `capRows` trims
 * them, so a `select * from huge_table` materializes every row in the server
 * process. `statement_timeout` does not bound this — the statement itself
 * succeeds. Streaming would need a cursor, which is incompatible with the
 * multi-statement simple query this module depends on.
 *
 * @module database/DatabaseExecutor
 */
import {
  DatabaseError,
  type DatabaseExecuteSqlInput,
  type DatabaseExecuteSqlResult,
  type DatabaseSqlStatementResult,
  type DatabaseTestConnectionInput,
  type DatabaseTestConnectionResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../serverSettings.ts";
import {
  capRows,
  describeConnectionTarget,
  resolveSslOption,
  sanitizeConnectionStringForDriver,
  SQL_CONNECT_TIMEOUT_MS,
  SQL_STATEMENT_TIMEOUT_MS,
  stringifyCell,
} from "./sqlConnection.ts";

export interface DatabaseExecutorShape {
  readonly executeSql: (
    input: DatabaseExecuteSqlInput,
  ) => Effect.Effect<DatabaseExecuteSqlResult, DatabaseError>;
  readonly testConnection: (
    input: DatabaseTestConnectionInput,
  ) => Effect.Effect<DatabaseTestConnectionResult, DatabaseError>;
}

export class DatabaseExecutor extends Context.Service<DatabaseExecutor, DatabaseExecutorShape>()(
  "t3/database/DatabaseExecutor",
) {}

/**
 * Shape of a `pg` error. Declared structurally so this module never has to
 * import `pg` at the type level for error handling.
 */
interface PostgresErrorLike {
  readonly message?: string;
  readonly code?: string;
  readonly detail?: string;
  readonly hint?: string;
  readonly position?: string | number;
  readonly severity?: string;
}

type RunOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DatabaseError };

function toDatabaseError(cause: unknown, fallbackMessage: string): DatabaseError {
  const error = (cause ?? {}) as PostgresErrorLike;
  const message = error.message?.trim() || fallbackMessage;
  const detailParts = [error.detail, error.hint].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  const positionRaw = typeof error.position === "string" ? Number(error.position) : error.position;
  const position =
    typeof positionRaw === "number" && Number.isInteger(positionRaw) && positionRaw >= 0
      ? positionRaw
      : undefined;

  return new DatabaseError({
    message,
    ...(error.code ? { code: error.code } : {}),
    ...(detailParts.length > 0 ? { detail: detailParts.join("\n") } : {}),
    ...(position !== undefined ? { position } : {}),
    cause,
  });
}

/**
 * A `pg` result, narrowed to the fields we consume.
 *
 * `rows` are positional arrays, not objects — every query is issued with
 * `rowMode: "array"`. In `pg`'s default object mode a row is keyed by field
 * name, so `select * from a join b` (or `select 1, 2`) collapses duplicate
 * column names and renders the same value twice with no error. Positional rows
 * line up 1:1 with `fields`, duplicates included.
 */
interface PgResultLike {
  readonly command?: string;
  readonly rowCount?: number | null;
  readonly fields?: ReadonlyArray<{ readonly name: string }>;
  readonly rows?: ReadonlyArray<ReadonlyArray<unknown>>;
}

function toStatementResult(result: PgResultLike): DatabaseSqlStatementResult {
  const columns = (result.fields ?? []).map((field) => field.name);
  const { rows, rowsTruncated } = capRows(result.rows ?? []);
  return {
    command: result.command ?? "",
    rowCount: Math.max(0, result.rowCount ?? 0),
    columns,
    // Pad/trim to the column count so a malformed row can never shift the grid.
    rows: rows.map((row) => columns.map((_column, index) => stringifyCell(row[index]))),
    rowsTruncated,
  };
}

const makeDatabaseExecutor = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;

  const resolveConnectionString = (
    connectionId: DatabaseExecuteSqlInput["connectionId"],
  ): Effect.Effect<string, DatabaseError> =>
    serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) => new DatabaseError({ message: "Failed to read database settings.", cause }),
      ),
      Effect.flatMap((settings) => {
        const connection = settings.databaseConnections[connectionId];
        if (!connection) {
          return Effect.fail(
            new DatabaseError({
              message: `No database connection is configured with id "${connectionId}".`,
            }),
          );
        }
        if (connection.connectionString.length === 0) {
          return Effect.fail(
            new DatabaseError({
              message: `Connection "${connection.label}" has no connection string. Add one in Settings → Database.`,
            }),
          );
        }
        return Effect.succeed(connection.connectionString);
      }),
    );

  /**
   * Open a client, hand it to `use`, and always close it. Any throw — from
   * connect, from the query, from the driver — becomes a `DatabaseError`
   * rather than a defect, so RPC callers see a typed failure.
   */
  const withClient = <T>(
    connectionString: string,
    fallbackMessage: string,
    use: (client: PgClientLike, notices: Array<string>) => Promise<T>,
  ): Effect.Effect<T, DatabaseError> =>
    Effect.promise<RunOutcome<T>>(async () => {
      const notices: Array<string> = [];
      let client: PgClientLike | null = null;
      try {
        const pg = await import("pg");
        const Client = (pg.default?.Client ?? pg.Client) as PgClientConstructor;
        client = new Client({
          // `pg` merges the parsed connection string over this config object,
          // so any TLS params must be stripped from the string for our `ssl`
          // decision to survive. `resolveSslOption` still reads the ORIGINAL.
          connectionString: sanitizeConnectionStringForDriver(connectionString),
          ssl: resolveSslOption(connectionString),
          connectionTimeoutMillis: SQL_CONNECT_TIMEOUT_MS,
          statement_timeout: SQL_STATEMENT_TIMEOUT_MS,
          query_timeout: SQL_STATEMENT_TIMEOUT_MS,
          application_name: "m3code",
        });
        // Without a listener, a mid-query connection drop surfaces as an
        // unhandled 'error' event and takes the server process down.
        client.on("error", () => {});
        client.on("notice", (notice: PostgresErrorLike) => {
          const text = notice.message?.trim();
          if (text) notices.push(text);
        });

        await client.connect();
        const value = await use(client, notices);
        return { ok: true, value };
      } catch (cause) {
        return { ok: false, error: toDatabaseError(cause, fallbackMessage) };
      } finally {
        if (client) {
          try {
            await client.end();
          } catch {
            // The connection is being discarded either way.
          }
        }
      }
    }).pipe(
      Effect.flatMap((outcome) =>
        outcome.ok ? Effect.succeed(outcome.value) : Effect.fail(outcome.error),
      ),
    );

  const executeSql: DatabaseExecutorShape["executeSql"] = Effect.fn("DatabaseExecutor.executeSql")(
    function* (input) {
      const connectionString = yield* resolveConnectionString(input.connectionId);
      // Timed around the whole round trip — connect included — so the number
      // shown in the UI matches what the user actually waited for.
      const startedAt = yield* Clock.currentTimeMillis;
      const executed = yield* withClient(
        connectionString,
        `Failed to run SQL against ${describeConnectionTarget(connectionString)}.`,
        async (client, notices) => {
          const raw = await client.query({ text: input.sql, rowMode: "array" });
          // A multi-statement simple query resolves to an array of results.
          const results = Array.isArray(raw) ? raw : [raw];
          return { results, notices: [...notices] };
        },
      );
      const finishedAt = yield* Clock.currentTimeMillis;
      return {
        statements: executed.results.map(toStatementResult),
        durationMs: Math.max(0, finishedAt - startedAt),
        notices: executed.notices,
      } satisfies DatabaseExecuteSqlResult;
    },
  );

  const testConnection: DatabaseExecutorShape["testConnection"] = Effect.fn(
    "DatabaseExecutor.testConnection",
  )(function* (input) {
    const connectionString = yield* resolveConnectionString(input.connectionId);
    const startedAt = yield* Clock.currentTimeMillis;
    const row = yield* withClient(
      connectionString,
      `Failed to connect to ${describeConnectionTarget(connectionString)}.`,
      async (client) => {
        const raw = await client.query({
          text: "select version(), current_database()",
          rowMode: "array",
        });
        const result = (Array.isArray(raw) ? raw[0] : raw) as PgResultLike | undefined;
        return result?.rows?.[0] ?? [];
      },
    );
    const finishedAt = yield* Clock.currentTimeMillis;
    return {
      serverVersion: stringifyCell(row[0]) ?? "",
      database: stringifyCell(row[1]) ?? "",
      latencyMs: Math.max(0, finishedAt - startedAt),
    } satisfies DatabaseTestConnectionResult;
  });

  return { executeSql, testConnection } satisfies DatabaseExecutorShape;
});

export const DatabaseExecutorLive = Layer.effect(DatabaseExecutor, makeDatabaseExecutor);

// ── Minimal structural view of the `pg` client ────────────────────────
// `pg` is imported lazily (it is only needed when someone actually runs SQL),
// so the surface we use is declared here instead of importing pg's types.

interface PgClientLike {
  connect(): Promise<unknown>;
  query(config: { text: string; rowMode: "array" }): Promise<PgResultLike | Array<PgResultLike>>;
  end(): Promise<void>;
  on(event: "error", listener: (error: unknown) => void): void;
  on(event: "notice", listener: (notice: PostgresErrorLike) => void): void;
}

interface PgClientConstructor {
  new (config: {
    connectionString: string;
    ssl: false | { rejectUnauthorized: boolean };
    connectionTimeoutMillis: number;
    statement_timeout: number;
    query_timeout: number;
    application_name: string;
  }): PgClientLike;
}
