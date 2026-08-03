import type { DatabaseConnectionConfig, DatabaseConnectionId } from "@t3tools/contracts";

export interface DatabaseConnectionEntry extends DatabaseConnectionConfig {
  readonly id: DatabaseConnectionId;
}

export function toConnectionEntries(
  connections: Readonly<Record<string, DatabaseConnectionConfig>>,
): ReadonlyArray<DatabaseConnectionEntry> {
  return Object.entries(connections).map(([id, connection]) => ({
    ...connection,
    id: id as DatabaseConnectionId,
  }));
}

/** Path comparison that survives Windows separators and trailing slashes. */
function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

export function isConnectionForProject(connection: DatabaseConnectionConfig, cwd: string): boolean {
  if (connection.projectPath.length === 0) return true;
  return normalizePath(connection.projectPath) === normalizePath(cwd);
}

/**
 * Connections offered for a project.
 *
 * A project that has been linked to its own database uses that link and
 * NOTHING else — shared "all projects" connections are hidden entirely once a
 * project-specific one exists. This is the safety property that matters when
 * you keep several Supabase projects side by side: a repo can only ever target
 * the database it was deliberately linked to, so there is no picker entry that
 * could apply a migration to the wrong project. Shared connections are only
 * offered to repos that have no link of their own.
 */
export function connectionsForProject(
  connections: Readonly<Record<string, DatabaseConnectionConfig>>,
  cwd: string,
): ReadonlyArray<DatabaseConnectionEntry> {
  const scoped: Array<DatabaseConnectionEntry> = [];
  const shared: Array<DatabaseConnectionEntry> = [];
  for (const entry of toConnectionEntries(connections)) {
    if (entry.projectPath.length === 0) {
      shared.push(entry);
    } else if (isConnectionForProject(entry, cwd)) {
      scoped.push(entry);
    }
  }
  const byLabel = (a: DatabaseConnectionEntry, b: DatabaseConnectionEntry) =>
    a.label.localeCompare(b.label);
  return scoped.length > 0 ? scoped.sort(byLabel) : shared.sort(byLabel);
}

/** Loose check so the link form can reject an obviously wrong paste. */
export function looksLikePostgresConnectionString(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "postgres:" || url.protocol === "postgresql:";
  } catch {
    return false;
  }
}

const CONNECTION_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Ids must match the contract slug pattern: leading letter, then [A-Za-z0-9_-]. */
export function newDatabaseConnectionId(): DatabaseConnectionId {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => CONNECTION_ID_ALPHABET[byte % 36]).join("");
  return `db${suffix}` as DatabaseConnectionId;
}

/** Host shown in the picker so two "Supabase" entries stay distinguishable. */
export function describeConnection(connection: DatabaseConnectionConfig): string | null {
  if (connection.connectionString.length > 0) {
    try {
      const url = new URL(connection.connectionString);
      return url.hostname;
    } catch {
      return null;
    }
  }
  return connection.connectionStringRedacted ? "credentials saved" : null;
}
