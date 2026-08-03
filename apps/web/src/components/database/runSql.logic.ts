/**
 * Presentation helpers for the Run SQL dialog. Kept separate from the
 * component so the offset math is unit-testable.
 */

export interface SqlErrorLocation {
  readonly line: number;
  readonly column: number;
  /** The offending source line, for display above a caret. */
  readonly lineText: string;
}

/**
 * Translate Postgres' 1-based character offset into a line/column pair.
 * Returns null when the position is missing or out of range.
 */
export function resolveSqlErrorLocation(
  sql: string,
  position: number | undefined,
): SqlErrorLocation | null {
  if (position === undefined || position <= 0 || position > sql.length + 1) return null;

  const offset = position - 1;
  const lineStart = sql.lastIndexOf("\n", offset - 1) + 1;
  const lineEndRaw = sql.indexOf("\n", offset);
  const lineEnd = lineEndRaw === -1 ? sql.length : lineEndRaw;
  let line = 1;
  for (let index = 0; index < lineStart; index += 1) {
    if (sql.charCodeAt(index) === 10) line += 1;
  }

  return {
    line,
    column: offset - lineStart + 1,
    lineText: sql.slice(lineStart, lineEnd).replace(/\r$/, ""),
  };
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 2 : 1)} s`;
}

/** "3 rows" / "1 row" / "no rows" */
export function formatRowCount(rowCount: number): string {
  if (rowCount === 0) return "no rows";
  return rowCount === 1 ? "1 row" : `${rowCount.toLocaleString()} rows`;
}

/**
 * Blank out string literals, dollar-quoted bodies, and comments so semicolons
 * and keywords inside them are not mistaken for real SQL. Deliberately naive —
 * callers only need a sense of shape, not a parser.
 */
function stripSqlNoise(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\$\$[\s\S]*?\$\$/g, "$$$$")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/** A rough statement count for the confirmation line. */
export function countStatements(sql: string): number {
  const count = stripSqlNoise(sql)
    .split(";")
    .filter((part) => part.trim().length > 0).length;
  return Math.max(1, count);
}

/**
 * Does the script drive its own transactions?
 *
 * This changes what we can promise the user. Postgres wraps a multi-statement
 * simple query in ONE implicit transaction — but only until the script issues
 * its own COMMIT or ROLLBACK, after which following statements run in a fresh
 * implicit transaction. So a migration shaped `BEGIN; …; COMMIT; …;` can very
 * much be left half-applied, and claiming otherwise would be a lie.
 */
export function hasExplicitTransactionControl(sql: string): boolean {
  return /\b(?:begin|commit|rollback|start\s+transaction|savepoint)\b/i.test(stripSqlNoise(sql));
}
