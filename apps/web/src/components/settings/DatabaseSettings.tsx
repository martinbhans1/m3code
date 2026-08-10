import { PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DatabaseConnectionConfig, DatabaseConnectionId } from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";

import { normalizeProjectPathForComparison } from "../../lib/projectPaths";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ensureEnvironmentApi } from "~/environmentApi";
import { usePrimaryEnvironmentId } from "~/environments/primary";
import { newDatabaseConnectionId, toConnectionEntries } from "../database/databaseConnections";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

/** Direct row in the card – same pattern as the Provider / Connections list rows. */
const ITEM_ROW_CLASSNAME = "border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5";

// The session pooler, not the direct `db.<ref>.supabase.co` host: Supabase
// serves direct connections over IPv6 only, so they fail with a bare
// `getaddrinfo ENOENT` on any machine without global IPv6. Port 5432 keeps full
// session semantics (transactions, DDL, prepared statements) — unlike the
// transaction pooler on 6543, which the one-transaction runner cannot use.
const CONNECTION_STRING_PLACEHOLDER =
  "postgresql://postgres.<ref>:[PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres";

/** Sentinel for the "All projects" option — `projectPath: ""` in the contract. */
const ALL_PROJECTS_VALUE = "*";

type ConnectionDraftRow = DatabaseConnectionConfig & {
  readonly id: DatabaseConnectionId;
};

type TestState =
  | { readonly status: "testing" }
  | { readonly status: "ok"; readonly message: string }
  | { readonly status: "error"; readonly message: string };

function toConnectionMap(
  rows: ReadonlyArray<ConnectionDraftRow>,
): Record<DatabaseConnectionId, DatabaseConnectionConfig> {
  const next: Record<string, DatabaseConnectionConfig> = {};
  for (const { id, ...config } of rows) {
    next[id] = config;
  }
  return next as Record<DatabaseConnectionId, DatabaseConnectionConfig>;
}

/**
 * A saved entry arrives as `{ connectionString: "", connectionStringRedacted: true }`.
 * Writing it back untouched is what keeps the stored secret in place — clearing
 * the flag (and the string) is what tells the server to drop it.
 */
function hasStoredSecret(connection: DatabaseConnectionConfig | undefined): boolean {
  if (!connection) return false;
  return connection.connectionStringRedacted === true || connection.connectionString.length > 0;
}

function formatTestError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "Could not reach the database.";
}

type DatabaseConnectionRowProps = {
  readonly row: ConnectionDraftRow;
  readonly index: number;
  readonly projectOptions: ReadonlyArray<{ readonly cwd: string; readonly name: string }>;
  readonly savedConnection: DatabaseConnectionConfig | undefined;
  readonly testState: TestState | undefined;
  readonly onChange: (id: DatabaseConnectionId, patch: Partial<DatabaseConnectionConfig>) => void;
  readonly onRemove: (id: DatabaseConnectionId) => void;
  readonly onTest: (id: DatabaseConnectionId) => void;
};

function DatabaseConnectionRow({
  row,
  index,
  projectOptions,
  savedConnection,
  testState,
  onChange,
  onRemove,
  onTest,
}: DatabaseConnectionRowProps) {
  const isSaved = savedConnection !== undefined;
  const canTest = isSaved && hasStoredSecret(savedConnection);
  const selectedProjectValue = row.projectPath.length === 0 ? ALL_PROJECTS_VALUE : row.projectPath;
  const selectedProjectLabel =
    row.projectPath.length === 0
      ? "All projects"
      : (projectOptions.find(
          (project) =>
            normalizeProjectPathForComparison(project.cwd) ===
            normalizeProjectPathForComparison(row.projectPath),
        )?.name ?? row.projectPath);

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Label</span>
          <DraftInput
            value={row.label}
            onCommit={(label) => onChange(row.id, { label })}
            placeholder="Supabase — staging"
            spellCheck={false}
            aria-label={`Connection label ${index + 1}`}
          />
        </label>
        {/* Not a <label>: it wraps a button trigger, which a label would re-toggle. */}
        <div className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Project</span>
          <Select
            value={selectedProjectValue}
            onValueChange={(value) =>
              onChange(row.id, {
                projectPath: value === ALL_PROJECTS_VALUE ? "" : String(value),
              })
            }
          >
            <SelectTrigger className="w-full" aria-label={`Connection project ${index + 1}`}>
              <SelectValue>{selectedProjectLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value={ALL_PROJECTS_VALUE}>
                All projects (shared)
              </SelectItem>
              {projectOptions.map((project) => (
                <SelectItem hideIndicator key={project.cwd} value={project.cwd}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>

      <label className="mt-3 block">
        <span className="mb-1.5 block text-xs font-medium text-foreground">Connection string</span>
        <DraftInput
          value={row.connectionStringRedacted ? "" : row.connectionString}
          onCommit={(connectionString) => onChange(row.id, { connectionString })}
          type="password"
          autoComplete="off"
          placeholder={
            row.connectionStringRedacted
              ? "Stored secret - enter a new value to replace"
              : CONNECTION_STRING_PLACEHOLDER
          }
          spellCheck={false}
          aria-label={`Connection string ${index + 1}`}
        />
        <span className="mt-1.5 block text-xs text-muted-foreground">
          In the Supabase dashboard this is the URI under Connect → Session pooler (or Direct
          connection). Stored separately from settings and never returned to the app after saving.
        </span>
      </label>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-xs text-muted-foreground">
          {testState?.status === "testing" ? (
            "Testing…"
          ) : testState?.status === "ok" ? (
            <span className="text-success">{testState.message}</span>
          ) : testState?.status === "error" ? (
            <span className="text-destructive">{testState.message}</span>
          ) : canTest ? (
            "Saved. Test to verify the credentials reach the database."
          ) : isSaved ? (
            "Add a connection string to enable testing."
          ) : (
            "Enter a label to save this connection, then test it."
          )}
        </p>
        <div className="flex shrink-0 items-center gap-2 sm:justify-end">
          <Button
            size="xs"
            variant="outline"
            disabled={!canTest || testState?.status === "testing"}
            onClick={() => onTest(row.id)}
          >
            {testState?.status === "testing" ? "Testing…" : "Test connection"}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-8 text-muted-foreground hover:text-destructive"
            onClick={() => onRemove(row.id)}
            aria-label={`Remove connection ${row.label || index + 1}`}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function DatabaseSettingsPanel() {
  const connections = useSettings((settings) => settings.databaseConnections);
  const { updateSettings } = useUpdateSettings();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const [rows, setRows] = useState<ReadonlyArray<ConnectionDraftRow>>(() => [
    ...toConnectionEntries(connections),
  ]);
  const [testStates, setTestStates] = useState<Readonly<Record<string, TestState>>>({});

  // Server pushes are authoritative; local rows only diverge while a new entry
  // is still missing its label (see `publishRows`).
  useEffect(() => {
    setRows((current) => {
      const saved = toConnectionEntries(connections);
      const savedIds = new Set(saved.map((entry) => entry.id));
      const pending = current.filter(
        (entry) => !savedIds.has(entry.id) && entry.label.trim().length === 0,
      );
      return [...saved, ...pending];
    });
  }, [connections]);

  const projectOptions = useMemo(() => {
    const byPath = new Map<string, { readonly cwd: string; readonly name: string }>();
    for (const project of projects) {
      const key = normalizeProjectPathForComparison(project.cwd);
      if (!byPath.has(key)) {
        byPath.set(key, { cwd: project.cwd, name: project.name });
      }
    }
    return [...byPath.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [projects]);

  /** Whole-map replacement — `ServerSettingsPatch.databaseConnections` has no per-entry patch. */
  const publishRows = useCallback(
    (nextRows: ReadonlyArray<ConnectionDraftRow>) => {
      // A blank label fails the contract schema. Rather than dropping the whole
      // patch — which would silently discard edits to *other* rows, including
      // deletions — resolve each blank individually: a never-saved row is held
      // back until it is named, and a saved row keeps its stored label until a
      // new one is typed, so clearing the field can never delete a connection.
      const savedById = new Map(toConnectionEntries(connections).map((entry) => [entry.id, entry]));
      const publishable = nextRows.flatMap((row) => {
        if (row.label.trim().length > 0) return [row];
        const saved = savedById.get(row.id);
        return saved ? [{ ...row, label: saved.label }] : [];
      });
      updateSettings({ databaseConnections: toConnectionMap(publishable) });
    },
    [connections, updateSettings],
  );

  const handleChange = useCallback(
    (id: DatabaseConnectionId, patch: Partial<DatabaseConnectionConfig>) => {
      const nextRows = rows.map((row) => {
        if (row.id !== id) return row;
        const next = { ...row, ...patch };
        if (patch.connectionString !== undefined) {
          // A typed value replaces the stored secret; an empty one clears it.
          // Either way the redaction flag must go, or the server keeps the old
          // secret instead of persisting what was entered.
          delete next.connectionStringRedacted;
        }
        return next;
      });
      setRows(nextRows);
      publishRows(nextRows);
    },
    [publishRows, rows],
  );

  const handleRemove = useCallback(
    (id: DatabaseConnectionId) => {
      const nextRows = rows.filter((row) => row.id !== id);
      setRows(nextRows);
      publishRows(nextRows);
    },
    [publishRows, rows],
  );

  const handleAdd = useCallback(() => {
    // Default to a real project, never the shared scope. A connection that
    // defaults to "all projects" is how a migration ends up applied to the
    // wrong database when several Supabase projects are open side by side.
    const firstUnlinked = projectOptions.find(
      (project) =>
        !rows.some(
          (row) =>
            row.projectPath.length > 0 &&
            normalizeProjectPathForComparison(row.projectPath) ===
              normalizeProjectPathForComparison(project.cwd),
        ),
    );
    const defaultProject = firstUnlinked ?? projectOptions[0];
    setRows((current) => [
      ...current,
      {
        id: newDatabaseConnectionId(),
        label: defaultProject?.name ?? "",
        projectPath: defaultProject?.cwd ?? "",
        connectionString: "",
      },
    ]);
  }, [projectOptions, rows]);

  const handleTest = useCallback(
    (connectionId: DatabaseConnectionId) => {
      if (!primaryEnvironmentId) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not test connection",
            description: "No environment is connected.",
          }),
        );
        return;
      }

      setTestStates((current) => ({ ...current, [connectionId]: { status: "testing" } }));
      void ensureEnvironmentApi(primaryEnvironmentId)
        .database.testConnection({ connectionId })
        .then((result) => {
          setTestStates((current) => ({
            ...current,
            [connectionId]: {
              status: "ok",
              message: `Connected to ${result.database} · ${result.serverVersion} · ${result.latencyMs}ms`,
            },
          }));
        })
        .catch((error: unknown) => {
          const message = formatTestError(error);
          setTestStates((current) => ({
            ...current,
            [connectionId]: { status: "error", message },
          }));
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not connect to the database",
              description: message,
            }),
          );
        });
    },
    [primaryEnvironmentId],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Database connections"
        headerAction={
          <Button size="xs" variant="default" onClick={handleAdd}>
            <PlusIcon className="size-3" />
            Add connection
          </Button>
        }
      >
        {rows.length === 0 ? (
          <SettingsRow
            title="No connections"
            description="Add a Postgres or Supabase connection to run .sql files against it from the file preview."
          />
        ) : (
          rows.map((row, index) => (
            <DatabaseConnectionRow
              key={row.id}
              row={row}
              index={index}
              projectOptions={projectOptions}
              savedConnection={connections[row.id]}
              testState={testStates[row.id]}
              onChange={handleChange}
              onRemove={handleRemove}
              onTest={handleTest}
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
