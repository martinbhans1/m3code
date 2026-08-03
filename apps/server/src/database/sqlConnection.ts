/**
 * Pure helpers for turning a user-supplied Postgres connection string into
 * driver options, and for rendering result values as strings.
 *
 * Kept free of `pg` and Effect imports so the behaviour is unit-testable
 * without a database or a runtime.
 *
 * @module database/sqlConnection
 */
import { DATABASE_RESULT_CELL_MAX_CHARS, DATABASE_RESULT_ROW_LIMIT } from "@t3tools/contracts";

/** How long a single run may occupy the server before Postgres cancels it. */
export const SQL_STATEMENT_TIMEOUT_MS = 120_000;
/** How long to wait for the TCP + TLS + auth handshake. */
export const SQL_CONNECT_TIMEOUT_MS = 15_000;

export type SqlSslOption = false | { readonly rejectUnauthorized: boolean };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Decide the TLS posture for a connection string.
 *
 * Supabase (and most hosted Postgres) terminate TLS with a certificate chain
 * that Node does not trust out of the box, so `require` deliberately maps to an
 * encrypted-but-unverified connection — the same thing `psql sslmode=require`
 * does. Callers who want verification opt in with `sslmode=verify-full`.
 */
export function resolveSslOption(connectionString: string): SqlSslOption {
  const parsed = parseConnectionString(connectionString);
  const sslmode = parsed?.searchParams.get("sslmode")?.toLowerCase();

  if (sslmode) {
    switch (sslmode) {
      case "disable":
        return false;
      case "verify-ca":
      case "verify-full":
        return { rejectUnauthorized: true };
      default:
        // allow / prefer / require
        return { rejectUnauthorized: false };
    }
  }

  // Only skip TLS when we can positively identify a loopback host. A string we
  // could not parse must not silently downgrade to an unencrypted connection.
  if (!parsed) return { rejectUnauthorized: false };
  return LOCAL_HOSTS.has(parsed.hostname.toLowerCase()) ? false : { rejectUnauthorized: false };
}

/**
 * TLS parameters that `pg` would otherwise interpret itself.
 *
 * `ConnectionParameters` merges the parsed connection string OVER the explicit
 * config object, and `pg-connection-string` turns any of these into `ssl: {}` —
 * which leaves `rejectUnauthorized` undefined and therefore Node-default true.
 * That would silently discard `resolveSslOption`'s decision and break the very
 * common `?sslmode=require` form against Supabase's untrusted chain. Stripping
 * them keeps this module the single source of truth for TLS posture.
 */
const PG_SSL_PARAMS = ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert"] as const;

/**
 * Remove TLS parameters from a connection string before handing it to `pg`.
 * Pair with `resolveSslOption`, which must be given the ORIGINAL string so the
 * user's `sslmode` still decides the posture.
 */
export function sanitizeConnectionStringForDriver(connectionString: string): string {
  const parsed = parseConnectionString(connectionString);
  if (!parsed) return connectionString;
  let changed = false;
  for (const param of PG_SSL_PARAMS) {
    if (parsed.searchParams.has(param)) {
      parsed.searchParams.delete(param);
      changed = true;
    }
  }
  return changed ? parsed.toString() : connectionString;
}

/** Host shown in UI/error messages. Never includes credentials. */
export function describeConnectionTarget(connectionString: string): string {
  const parsed = parseConnectionString(connectionString);
  if (!parsed) return "the database";
  const database = parsed.pathname.replace(/^\//, "");
  const port = parsed.port ? `:${parsed.port}` : "";
  return database ? `${parsed.hostname}${port}/${database}` : `${parsed.hostname}${port}`;
}

function parseConnectionString(connectionString: string): URL | null {
  try {
    const url = new URL(connectionString);
    return url.protocol === "postgres:" || url.protocol === "postgresql:" ? url : null;
  } catch {
    return null;
  }
}

export function isProbablyPostgresConnectionString(value: string): boolean {
  return parseConnectionString(value.trim()) !== null;
}

function truncateCell(value: string): string {
  return value.length > DATABASE_RESULT_CELL_MAX_CHARS
    ? `${value.slice(0, DATABASE_RESULT_CELL_MAX_CHARS)}…`
    : value;
}

/**
 * Render one cell for the wire. Postgres can hand back Dates, Buffers, arrays,
 * and arbitrary JSON; the contract only carries strings, so everything is
 * normalized here rather than at the schema boundary.
 */
export function stringifyCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return truncateCell(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    const hex = Buffer.from(value).toString("hex");
    return truncateCell(`\\x${hex}`);
  }
  try {
    return truncateCell(JSON.stringify(value) ?? String(value));
  } catch {
    return truncateCell(String(value));
  }
}

export function capRows<T>(rows: ReadonlyArray<T>): {
  readonly rows: ReadonlyArray<T>;
  readonly rowsTruncated: boolean;
} {
  return rows.length > DATABASE_RESULT_ROW_LIMIT
    ? { rows: rows.slice(0, DATABASE_RESULT_ROW_LIMIT), rowsTruncated: true }
    : { rows, rowsTruncated: false };
}
