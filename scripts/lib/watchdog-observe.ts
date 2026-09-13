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
  readonly pendingApprovalCount: number;
  readonly pendingUserInputCount: number;
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
  /** Conversations whose newest turn failed. The only ones eligible for a restart. */
  readonly threads: readonly ThreadObservation[];
  /**
   * Everything left mid-turn, failures included: a turn that never finished
   * because the app was killed looks nothing like a failure in the data, and is
   * the shape that goes unnoticed for weeks. Never restarted, only listed.
   */
  readonly stoppedMidWork: readonly ThreadObservation[];
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
/**
 * Turn states that mean the work stopped without finishing. `running` and
 * `pending` are in here because a turn interrupted by a crash or a forced quit
 * is never marked as anything else - it simply stops being true.
 */
const UNFINISHED_TURN_STATES = ["error", "running", "pending", "interrupted"] as const;

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
        t.pending_approval_count as pendingApprovalCount,
        t.pending_user_input_count as pendingUserInputCount,
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
    and lt.state in (SELECT value FROM json_each(?))`;

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
    const rows = database
      .prepare(CANDIDATE_THREADS_SQL)
      .all(JSON.stringify(UNFINISHED_TURN_STATES)) as readonly Record<
      string,
      string | number | null
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
      const text = (column: string): string | null => {
        const value = row[column];
        return typeof value === "string" ? value : null;
      };
      const count = (column: string): number => {
        const value = row[column];
        return typeof value === "number" ? value : 0;
      };
      const errorRow = latestRuntimeError.get(threadId) as
        | {
            readonly payloadJson: string;
            readonly createdAt: string;
            readonly turnId: string | null;
          }
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
        title: text("title") ?? "",
        projectId: text("projectId") ?? "",
        projectTitle: text("projectTitle") ?? null,
        workspaceRoot: text("workspaceRoot") ?? null,
        isOrchestrator:
          orchestratorProjectId !== null && text("projectId") === orchestratorProjectId,
        runtimeMode: text("runtimeMode") ?? "full-access",
        interactionMode: text("interactionMode") ?? "default",
        modelSelection: parseJsonOrNull(text("modelSelectionJson")),
        archivedAt: text("archivedAt") ?? null,
        doneAt: text("doneAt") ?? null,
        latestUserMessageAt: text("latestUserMessageAt") ?? null,
        threadUpdatedAt: text("threadUpdatedAt") ?? "",
        pendingApprovalCount: count("pendingApprovalCount"),
        pendingUserInputCount: count("pendingUserInputCount"),
        latestTurn: {
          turnId: text("turnId") ?? null,
          state: text("turnState") ?? "error",
          requestedAt: text("turnRequestedAt") ?? "",
          startedAt: text("turnStartedAt") ?? null,
          completedAt: text("turnCompletedAt") ?? null,
        },
        newestTurnRequestedAt: turnRow.newestTurnRequestedAt,
        sessionStatus: text("sessionStatus") ?? null,
        sessionUpdatedAt: text("sessionUpdatedAt") ?? null,
        providerName: text("providerName") ?? null,
        providerInstanceId: text("providerInstanceId") ?? null,
        runtimeErrorMessage: errorPayload?.message ?? null,
        runtimeErrorAt: errorRow?.createdAt ?? null,
        runtimeErrorTurnId: errorRow?.turnId ?? null,
        latestActivityAt: activityRow.latestActivityAt,
      };
    });

    const failed = threads.filter((thread) => thread.latestTurn?.state === FAILED_TURN_STATE);
    return {
      takenAt: now.toISOString(),
      databaseFile: paths.databaseFile,
      serverPid: runtime?.pid ?? null,
      serverOrigin: runtime?.origin ?? null,
      serverRunning: running,
      orchestratorProjectId,
      threadsWithFailedLatestTurn: failed.length,
      threads: failed,
      stoppedMidWork: threads,
    };
  } finally {
    database.close();
  }
}
