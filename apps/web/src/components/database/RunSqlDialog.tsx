// oxlint-disable no-array-index-key -- The result grid renders an immutable
// snapshot of one execution: statements, columns, rows, and cells are never
// reordered, inserted into, or filtered, and none carry a natural id. Position
// is the only stable identity, and the grid is replaced wholesale on each run.
import type {
  DatabaseConnectionId,
  DatabaseExecuteSqlResult,
  EnvironmentId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangleIcon, DatabaseIcon, LoaderCircle, PlayIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ensureEnvironmentApi } from "~/environmentApi";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import {
  connectionsForProject,
  describeConnection,
  looksLikePostgresConnectionString,
  newDatabaseConnectionId,
} from "./databaseConnections";
import {
  countStatements,
  formatDuration,
  formatRowCount,
  hasExplicitTransactionControl,
  resolveSqlErrorLocation,
} from "./runSql.logic";

const LAST_CONNECTION_STORAGE_PREFIX = "m3code.runSql.lastConnection:";

interface RunSqlError {
  readonly message: string;
  readonly code?: string;
  readonly detail?: string;
  readonly position?: number;
}

interface RunSqlDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  relativePath: string;
  sql: string;
}

function readLastConnectionId(cwd: string): string | null {
  try {
    return window.localStorage.getItem(`${LAST_CONNECTION_STORAGE_PREFIX}${cwd}`);
  } catch {
    return null;
  }
}

function persistLastConnectionId(cwd: string, connectionId: string): void {
  try {
    window.localStorage.setItem(`${LAST_CONNECTION_STORAGE_PREFIX}${cwd}`, connectionId);
  } catch {}
}

/**
 * Errors come back as the decoded `DatabaseError` over RPC, but a transport
 * failure surfaces as a plain `Error`. Normalize both into one shape.
 */
function toRunSqlError(cause: unknown): RunSqlError {
  const error = cause as Partial<RunSqlError> & { message?: string };
  return {
    message: error?.message?.trim() || "The query failed.",
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.detail ? { detail: error.detail } : {}),
    ...(typeof error?.position === "number" ? { position: error.position } : {}),
  };
}

export function RunSqlDialog({
  open,
  onOpenChange,
  environmentId,
  cwd,
  projectName,
  relativePath,
  sql,
}: RunSqlDialogProps) {
  const navigate = useNavigate();
  const { updateSettings } = useUpdateSettings();
  const databaseConnections = useSettings((settings) => settings.databaseConnections);
  const connections = useMemo(
    () => connectionsForProject(databaseConnections ?? {}, cwd),
    [databaseConnections, cwd],
  );

  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DatabaseExecuteSqlResult | null>(null);
  const [error, setError] = useState<RunSqlError | null>(null);
  const [linkDraft, setLinkDraft] = useState("");

  // Each open starts fresh.
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError(null);
    setRunning(false);
    setConnectionId(null);
    setLinkDraft("");
  }, [open, cwd]);

  // Pick a default once connections are available. Guarded on `connectionId`
  // being unset so a later settings change cannot stomp the user's choice —
  // but unlike a one-shot effect this still resolves when settings hydrate
  // after the dialog has already opened.
  useEffect(() => {
    if (!open || connectionId !== null || connections.length === 0) return;
    const remembered = readLastConnectionId(cwd);
    const preferred =
      connections.find((connection) => connection.id === remembered) ?? connections[0];
    setConnectionId(preferred?.id ?? null);
  }, [open, cwd, connectionId, connections]);

  // `DatabaseExecuteSqlInput.sql` is a TrimmedString, so the server executes —
  // and Postgres reports error offsets into — the trimmed text. Trim here too,
  // or the caret drifts by however much leading whitespace the file had.
  const trimmedSql = useMemo(() => sql.trim(), [sql]);
  const statementCount = useMemo(() => countStatements(trimmedSql), [trimmedSql]);
  const managesOwnTransactions = useMemo(
    () => hasExplicitTransactionControl(trimmedSql),
    [trimmedSql],
  );
  const selectedConnection = connections.find((connection) => connection.id === connectionId);
  const errorLocation = resolveSqlErrorLocation(trimmedSql, error?.position);

  /**
   * Link this project to a database. Scoped to `cwd`, so it is remembered for
   * this repo permanently and can never be offered to another one.
   */
  const handleLink = () => {
    const connectionString = linkDraft.trim();
    if (!looksLikePostgresConnectionString(connectionString)) return;
    const id = newDatabaseConnectionId();
    updateSettings({
      databaseConnections: {
        ...databaseConnections,
        [id]: { label: projectName, projectPath: cwd, connectionString },
      },
    });
    setConnectionId(id);
    setLinkDraft("");
  };

  const handleRun = async () => {
    if (!connectionId || running) return;
    setRunning(true);
    setError(null);
    setResult(null);
    persistLastConnectionId(cwd, connectionId);
    try {
      const executed = await ensureEnvironmentApi(environmentId).database.executeSql({
        connectionId: connectionId as DatabaseConnectionId,
        sql: trimmedSql,
      });
      setResult(executed);
    } catch (cause) {
      setError(toRunSqlError(cause));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader className="border-b border-border/70 bg-background">
          <DialogTitle className="flex items-center gap-2">
            <DatabaseIcon className="size-4" aria-hidden />
            Run {relativePath.split(/[\\/]/).pop()}
          </DialogTitle>
          <DialogDescription>
            {connections.length === 0
              ? `${projectName} is not linked to a database yet — link it once below.`
              : managesOwnTransactions
                ? `Runs ${statementCount === 1 ? "1 statement" : `${statementCount} statements`}. This script manages its own transactions, so a failure part-way through can leave earlier changes applied.`
                : `Runs all ${statementCount === 1 ? "1 statement" : `${statementCount} statements`} in one transaction — if any statement fails, nothing is applied.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
          {connections.length === 0 ? (
            <div className="grid gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-4">
              <div className="grid gap-1">
                <span className="text-xs font-medium text-foreground">
                  Link {projectName} to a database
                </span>
                <p className="text-[11px] text-muted-foreground">
                  Paste the Postgres URI once — for Supabase it is in the dashboard under Connect →
                  Session pooler. It is stored encrypted on the server, scoped to this project, and
                  reused every time from now on.
                </p>
              </div>
              <Input
                value={linkDraft}
                onChange={(event) => setLinkDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleLink();
                }}
                placeholder="postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres"
                spellCheck={false}
                autoComplete="off"
                aria-label={`Postgres connection string for ${projectName}`}
                className="bg-background font-mono text-[11px]"
              />
              <div className="flex items-center justify-between gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-xs text-muted-foreground"
                  onClick={() => {
                    onOpenChange(false);
                    void navigate({ to: "/settings/database" });
                  }}
                >
                  Manage in settings
                </Button>
                <Button
                  size="sm"
                  disabled={!looksLikePostgresConnectionString(linkDraft)}
                  onClick={handleLink}
                >
                  Link project
                </Button>
              </div>
            </div>
          ) : connections.length === 1 ? (
            // Linked and unambiguous — show the target, do not ask.
            <div className="flex items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2">
              <DatabaseIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate text-xs text-foreground">
                {connections[0]?.label}
              </span>
              {describeConnection(connections[0]!) ? (
                <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                  {describeConnection(connections[0]!)}
                </span>
              ) : null}
            </div>
          ) : (
            <div className="grid gap-2">
              <span className="text-xs font-medium text-foreground">Connection</span>
              <Select
                value={connectionId ?? ""}
                onValueChange={(value) => setConnectionId(String(value))}
                items={connections.map((connection) => ({
                  value: connection.id,
                  label: connection.label,
                }))}
              >
                <SelectTrigger className="w-full" aria-label="Database connection">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {connections.map((connection) => {
                    const target = describeConnection(connection);
                    return (
                      <SelectItem key={connection.id} value={connection.id}>
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <span className="truncate">{connection.label}</span>
                          {target ? (
                            <span className="truncate text-[11px] text-muted-foreground">
                              {target}
                            </span>
                          ) : null}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
              {selectedConnection && selectedConnection.projectPath.length === 0 ? (
                <span className="text-[11px] text-amber-700 dark:text-amber-300">
                  Shared connection — not linked to {projectName}. Link this project in settings to
                  pin it to one database.
                </span>
              ) : null}
            </div>
          )}

          <div className="grid gap-2">
            <span className="text-xs font-medium text-foreground">SQL</span>
            <ScrollArea className="max-h-40 rounded-lg border bg-muted/30">
              <pre className="px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre">
                {trimmedSql}
              </pre>
            </ScrollArea>
          </div>

          {error ? (
            <div className="grid gap-2 rounded-lg border border-destructive/40 bg-destructive/8 px-4 py-3">
              <div className="flex items-start gap-2">
                <AlertTriangleIcon
                  className="mt-0.5 size-4 shrink-0 text-destructive"
                  aria-hidden
                />
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium text-destructive">{error.message}</p>
                  {error.detail ? (
                    <p className="text-xs whitespace-pre-wrap text-destructive/85">
                      {error.detail}
                    </p>
                  ) : null}
                  {error.code ? (
                    <p className="font-mono text-[11px] text-destructive/70">
                      SQLSTATE {error.code}
                    </p>
                  ) : null}
                </div>
              </div>
              {errorLocation ? (
                <pre className="overflow-x-auto rounded border border-destructive/25 bg-background/60 px-3 py-2 font-mono text-[11px] leading-relaxed">
                  {`line ${errorLocation.line}: ${errorLocation.lineText}\n${" ".repeat(
                    `line ${errorLocation.line}: `.length + Math.max(0, errorLocation.column - 1),
                  )}^`}
                </pre>
              ) : null}
            </div>
          ) : null}

          {result ? (
            <div className="grid gap-3">
              <p className="text-xs text-muted-foreground">
                Completed in {formatDuration(result.durationMs)}.
              </p>
              {result.notices.length > 0 ? (
                <div className="grid gap-1 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2">
                  {result.notices.map((notice, index) => (
                    <p
                      key={`${index}-${notice}`}
                      className="text-[11px] text-amber-700 dark:text-amber-300"
                    >
                      {notice}
                    </p>
                  ))}
                </div>
              ) : null}
              {result.statements.map((statement, index) => (
                <div key={index} className="grid gap-1.5">
                  <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                    {statement.command || "Statement"} · {formatRowCount(statement.rowCount)}
                    {statement.rowsTruncated ? ` · showing first ${statement.rows.length}` : ""}
                  </p>
                  {statement.columns.length > 0 && statement.rows.length > 0 ? (
                    <ScrollArea className="max-h-64 rounded-lg border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {statement.columns.map((column, columnIndex) => (
                              <TableHead key={`${columnIndex}-${column}`} className="text-[11px]">
                                {column}
                              </TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {statement.rows.map((row, rowIndex) => (
                            <TableRow key={rowIndex}>
                              {row.map((cell, cellIndex) => (
                                <TableCell
                                  key={cellIndex}
                                  className={cn(
                                    "max-w-64 truncate font-mono text-[11px]",
                                    cell === null && "text-muted-foreground/60 italic",
                                  )}
                                  title={cell ?? "NULL"}
                                >
                                  {cell ?? "NULL"}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </ScrollArea>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <DialogFooter className="border-t bg-background">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {result ? "Done" : "Cancel"}
          </Button>
          <Button size="sm" disabled={!connectionId || running} onClick={() => void handleRun()}>
            {running ? (
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <PlayIcon className="size-3.5" aria-hidden />
            )}
            {running ? "Running…" : result || error ? "Run again" : "Run"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
