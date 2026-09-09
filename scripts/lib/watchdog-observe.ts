// @effect-diagnostics globalDate:off - Standalone watchdog process, no Effect runtime.
/**
 * watchdog-observe - Read the app's own state store to find conversations that
 * stopped mid-work, without touching the app.
 *
 * Everything here is read-only and additive: the running app owns this database
 * and the watchdog is a guest in it. Observation is deliberately separate from
 * the decision, so the snapshot written to the scan record is exactly what the
 * decision was made from.
 */
// @effect-diagnostics nodeBuiltinImport:off - must run standalone of the app runtime
import { DatabaseSync } from "node:sqlite";

import { isPidAlive, readJsonFile, type WatchdogPaths } from "./watchdog-store.ts";

export interface TurnObservation {
  readonly turnId: string | null;
  readonly state: string;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface ThreadObservation {
  readonly threadId: string;
  readonly title: string;
  readonly projectId: string;
  readonly projectTitle: string | null;
  readonly workspaceRoot: string | null;
  readonly isOrchestrator: boolean;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly modelSelection: unknown;
  readonly archivedAt: string | null;
  readonly doneAt: string | null;
  readonly latestUserMessageAt: string | null;
  readonly threadUpdatedAt: string;
  readonly latestTurn: TurnObservation | null;
  readonly newestTurnRequestedAt: string | null;
  readonly sessionStatus: string | null;
  readonly sessionUpdatedAt: string | null;
  readonly providerName: string | null;
  readonly providerInstanceId: string | null;
  readonly runtimeErrorMessage: string | null;
  readonly runtimeErrorAt: string | null;
  readonly runtimeErrorTurnId: string | null;
  readonly latestActivityAt: string | null;
}

export interface Snapshot {
  readonly takenAt: string;
  readonly databaseFile: string;
  readonly serverPid: number | null;
  readonly serverOrigin: string | null;
  readonly serverRunning: boolean;
  readonly orchestratorProjectId: string | null;
  readonly threadsWithFailedLatestTurn: number;
  readonly threads: readonly ThreadObservation[];
}

interface ServerRuntime {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly origin: string;
}

/**
 * Is the app actually up? A nudge is delivered through the running server, so a
 * scan that finds it down has nothing to do but record that.
 */
export function readServerRuntime(paths: WatchdogPaths): {
  readonly runtime: ServerRuntime | null;
  readonly running: boolean;
} {
  const runtime = readJsonFile<ServerRuntime>(paths.serverRuntimeFile);
  return { runtime, running: runtime !== null && isPidAlive(runtime.pid) };
}

export function readOrchestratorProjectId(paths: WatchdogPaths): string | null {
  const settings = readJsonFile<{ orchestratorProjectId?: string }>(paths.settingsFile);
  return settings?.orchestratorProjectId ?? null;
}

const FAILED_TURN_STATE = "error";

const CANDIDATE_THREADS_SQL = `select t.thread_id      as threadId,
        t.title          as title,
        t.project_id     as projectId,
        t.runtime_mode   as runtimeMode,
        t.interaction_mode as interactionMode,
        t.model_selection_json as modelSelectionJson,
        t.archived_at    as archivedAt,
        t.done_at        as doneAt,
        t.latest_user_message_at as latestUserMessageAt,
        t.updated_at     as threadUpdatedAt,
        p.title          as projectTitle,
        p.workspace_root as workspaceRoot,
        s.status         as sessionStatus,
        s.updated_at     as sessionUpdatedAt,
        s.provider_name  as providerName,
        s.provider_instance_id as providerInstanceId,
        lt.turn_id       as turnId,
        lt.state         as turnState,
        lt.requested_at  as turnRequestedAt,
        lt.started_at    as turnStartedAt,
        lt.completed_at  as turnCompletedAt
   from projection_threads t
   join projection_turns lt
     on lt.row_id = (select max(row_id) from projection_turns where thread_id = t.thread_id)
   left join projection_projects p on p.project_id = t.project_id
   left join projection_thread_sessions s on s.thread_id = t.thread_id
  where t.deleted_at is null
    and t.archived_at is null
    and lt.state = ?`;

function parseJsonOrNull(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function observe(paths: WatchdogPaths, now = new Date()): Snapshot {
  const { runtime, running } = readServerRuntime(paths);
  const orchestratorProjectId = readOrchestratorProjectId(paths);
  const database = new DatabaseSync(paths.databaseFile, { readOnly: true });
  try {
    const rows = database.prepare(CANDIDATE_THREADS_SQL).all(FAILED_TURN_STATE) as readonly Record<
      string,
      string | null
    >[];

    const latestRuntimeError = database.prepare(
      `select payload_json as payloadJson, created_at as createdAt, turn_id as turnId
         from projection_thread_activities
        where thread_id = ? and kind = 'runtime.error'
        order by created_at desc
        limit 1`,
    );
    const latestActivity = database.prepare(
      `select max(created_at) as latestActivityAt
         from projection_thread_activities where thread_id = ?`,
    );
    const newestTurn = database.prepare(
      `select max(requested_at) as newestTurnRequestedAt
         from projection_turns where thread_id = ?`,
    );

    const threads = rows.map((row): ThreadObservation => {
      const threadId = row["threadId"] as string;
      const errorRow = latestRuntimeError.get(threadId) as
        | { readonly payloadJson: string; readonly createdAt: string; readonly turnId: string | null }
        | undefined;
      const errorPayload = errorRow
        ? (parseJsonOrNull(errorRow.payloadJson) as { message?: string } | null)
        : null;
      const activityRow = latestActivity.get(threadId) as {
        readonly latestActivityAt: string | null;
      };
      const turnRow = newestTurn.get(threadId) as {
        readonly newestTurnRequestedAt: string | null;
      };
      return {
        threadId,
        title: row["title"] ?? "",
        projectId: row["projectId"] ?? "",
        projectTitle: row["projectTitle"] ?? null,
        workspaceRoot: row["workspaceRoot"] ?? null,
        isOrchestrator: orchestratorProjectId !== null && row["projectId"] === orchestratorProjectId,
        runtimeMode: row["runtimeMode"] ?? "full-access",
        interactionMode: row["interactionMode"] ?? "default",
        modelSelection: parseJsonOrNull(row["modelSelectionJson"]),
        archivedAt: row["archivedAt"] ?? null,
        doneAt: row["doneAt"] ?? null,
        latestUserMessageAt: row["latestUserMessageAt"] ?? null,
        threadUpdatedAt: row["threadUpdatedAt"] ?? "",
        latestTurn: {
          turnId: row["turnId"] ?? null,
          state: row["turnState"] as string,
          requestedAt: row["turnRequestedAt"] as string,
          startedAt: row["turnStartedAt"] ?? null,
          completedAt: row["turnCompletedAt"] ?? null,
        },
        newestTurnRequestedAt: turnRow.newestTurnRequestedAt,
        sessionStatus: row["sessionStatus"] ?? null,
        sessionUpdatedAt: row["sessionUpdatedAt"] ?? null,
        providerName: row["providerName"] ?? null,
        providerInstanceId: row["providerInstanceId"] ?? null,
        runtimeErrorMessage: errorPayload?.message ?? null,
        runtimeErrorAt: errorRow?.createdAt ?? null,
        runtimeErrorTurnId: errorRow?.turnId ?? null,
        latestActivityAt: activityRow.latestActivityAt,
      };
    });

    return {
      takenAt: now.toISOString(),
      databaseFile: paths.databaseFile,
      serverPid: runtime?.pid ?? null,
      serverOrigin: runtime?.origin ?? null,
      serverRunning: running,
      orchestratorProjectId,
      threadsWithFailedLatestTurn: threads.length,
      threads,
    };
  } finally {
    database.close();
  }
}
