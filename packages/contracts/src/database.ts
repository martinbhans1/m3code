/**
 * Database contracts — running SQL against a project's Postgres/Supabase
 * database straight from the file preview panel.
 *
 * Connections are configured per project (see `DatabaseConnectionConfig`) and
 * stored in `ServerSettings.databaseConnections`. The connection string itself
 * never lives in `settings.json`: the server moves it into the secret store and
 * blanks the field before the settings snapshot reaches a client, exactly like
 * sensitive provider environment variables.
 *
 * @module database
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

const DATABASE_CONNECTION_ID_MAX_CHARS = 64;
const DATABASE_CONNECTION_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const DATABASE_CONNECTION_LABEL_MAX_CHARS = 120;

/** Max characters of SQL accepted in one run. Guards against pasting a dump. */
export const DATABASE_SQL_MAX_CHARS = 1_000_000;
/** Rows retained per statement before the result is marked truncated. */
export const DATABASE_RESULT_ROW_LIMIT = 500;
/** Characters retained per cell before the value is elided. */
export const DATABASE_RESULT_CELL_MAX_CHARS = 2_000;

export const DatabaseConnectionId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(DATABASE_CONNECTION_ID_MAX_CHARS),
  Schema.isPattern(DATABASE_CONNECTION_ID_PATTERN),
).pipe(Schema.brand("DatabaseConnectionId"));
export type DatabaseConnectionId = typeof DatabaseConnectionId.Type;

export const DatabaseConnectionConfig = Schema.Struct({
  /** Human label shown in the connection picker (e.g. "Supabase — staging"). */
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(DATABASE_CONNECTION_LABEL_MAX_CHARS)),
  /**
   * Absolute path of the project this connection belongs to. An empty string
   * means the connection is offered for every project.
   */
  projectPath: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * Postgres connection string. Blank in any snapshot handed to a client —
   * `connectionStringRedacted` tells the UI a value exists server-side.
   */
  connectionString: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  connectionStringRedacted: Schema.optionalKey(Schema.Boolean),
});
export type DatabaseConnectionConfig = typeof DatabaseConnectionConfig.Type;

export const DatabaseExecuteSqlInput = Schema.Struct({
  connectionId: DatabaseConnectionId,
  sql: TrimmedNonEmptyString.check(Schema.isMaxLength(DATABASE_SQL_MAX_CHARS)),
});
export type DatabaseExecuteSqlInput = typeof DatabaseExecuteSqlInput.Type;

/**
 * One statement's result. Values are pre-stringified server-side so the wire
 * schema stays closed — a Postgres row can hold arbitrary JSON, arrays, and
 * custom types that have no useful contract representation.
 */
export const DatabaseSqlStatementResult = Schema.Struct({
  /** Postgres command tag: SELECT, INSERT, CREATE, … */
  command: TrimmedString,
  rowCount: NonNegativeInt,
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Schema.NullOr(Schema.String))),
  rowsTruncated: Schema.Boolean,
});
export type DatabaseSqlStatementResult = typeof DatabaseSqlStatementResult.Type;

export const DatabaseExecuteSqlResult = Schema.Struct({
  statements: Schema.Array(DatabaseSqlStatementResult),
  durationMs: NonNegativeInt,
  /** Notices raised during execution (RAISE NOTICE, index-already-exists, …). */
  notices: Schema.Array(Schema.String),
});
export type DatabaseExecuteSqlResult = typeof DatabaseExecuteSqlResult.Type;

export const DatabaseTestConnectionInput = Schema.Struct({
  connectionId: DatabaseConnectionId,
});
export type DatabaseTestConnectionInput = typeof DatabaseTestConnectionInput.Type;

export const DatabaseTestConnectionResult = Schema.Struct({
  serverVersion: TrimmedString,
  database: TrimmedString,
  latencyMs: NonNegativeInt,
});
export type DatabaseTestConnectionResult = typeof DatabaseTestConnectionResult.Type;

export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("DatabaseError", {
  message: TrimmedNonEmptyString,
  /** Postgres SQLSTATE, when the failure came from the server. */
  code: Schema.optional(Schema.String),
  /** Postgres DETAIL/HINT text, when present. */
  detail: Schema.optional(Schema.String),
  /** 1-based character offset into the submitted SQL, when Postgres reports one. */
  position: Schema.optional(NonNegativeInt),
  cause: Schema.optional(Schema.Defect()),
}) {}
