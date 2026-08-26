import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";

export type AgentAwarenessPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export interface AgentAwarenessState {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly phase: AgentAwarenessPhase;
  readonly headline: string;
  readonly detail?: string;
  readonly modelTitle: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

export interface ProjectThreadAwarenessInput {
  readonly environmentId: EnvironmentId;
  /**
   * Epoch milliseconds, used only to decide whether a running turn has gone
   * silent. Required rather than defaulted so no caller reports a dead turn as
   * live simply by forgetting to pass the time.
   */
  readonly now: number;
  readonly project: Pick<OrchestrationProjectShell, "title">;
  readonly thread: Pick<
    OrchestrationThreadShell,
    | "id"
    | "title"
    | "modelSelection"
    | "session"
    | "latestTurn"
    | "updatedAt"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
  >;
}

export function buildAgentAwarenessDeepLink(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): string {
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

export function isTerminalAgentAwarenessPhase(phase: AgentAwarenessPhase): boolean {
  return phase === "completed" || phase === "failed";
}

export function isInterruptiveAgentAwarenessPhase(phase: AgentAwarenessPhase): boolean {
  return phase === "waiting_for_approval" || phase === "waiting_for_input" || phase === "failed";
}

/**
 * How long a turn may claim to be running without its session being touched
 * before we stop believing it.
 *
 * A turn only ever leaves "running" because an event says so, and that event
 * is lost whenever the app is killed, a provider dies, or a machine sleeps —
 * so a thread can sit at "running" indefinitely with nothing behind it. Those
 * threads are worse than merely wrong: they crowd out the genuinely active
 * ones in every "what is working right now" view.
 *
 * An hour is deliberately far past any real turn. A long agent run touches its
 * session well inside that, so the threshold only catches turns that have
 * actually stopped reporting rather than ones that are simply slow.
 */
export const STALE_RUNNING_TURN_MS = 60 * 60 * 1000;

/**
 * True when a thread claims to be starting or running but has not been heard
 * from within {@link STALE_RUNNING_TURN_MS}.
 *
 * Takes the timestamps rather than a thread so the web can reuse it against
 * its own sidebar summaries.
 */
export function isStaleRunningTurn(input: {
  readonly isRunning: boolean;
  /** Latest sign of life: the session's own timestamp, else the thread's. */
  readonly lastActivityAt: string | null | undefined;
  /** Epoch milliseconds. Passed in rather than read, so this stays pure. */
  readonly now: number;
}): boolean {
  if (!input.isRunning) return false;
  // No timestamp at all is not evidence of staleness — say running.
  if (!input.lastActivityAt) return false;
  const lastActivityAt = Date.parse(input.lastActivityAt);
  if (Number.isNaN(lastActivityAt)) return false;
  return input.now - lastActivityAt >= STALE_RUNNING_TURN_MS;
}

export function projectThreadAwareness(
  input: ProjectThreadAwarenessInput,
): AgentAwarenessState | null {
  const { environmentId, project, thread } = input;
  const phase = resolveThreadAwarenessPhase(thread, input.now);
  if (!phase) {
    return null;
  }

  const detail = detailForPhase(phase, thread);
  return {
    environmentId,
    threadId: thread.id,
    projectTitle: project.title,
    threadTitle: thread.title,
    phase,
    headline: headlineForPhase(phase),
    ...(detail === undefined ? {} : { detail }),
    modelTitle: thread.modelSelection.model,
    updatedAt: thread.updatedAt,
    deepLink: buildAgentAwarenessDeepLink({ environmentId, threadId: thread.id }),
  };
}

function resolveThreadAwarenessPhase(
  thread: ProjectThreadAwarenessInput["thread"],
  now: number,
): AgentAwarenessPhase | null {
  if (thread.hasPendingApprovals) {
    return "waiting_for_approval";
  }
  if (thread.hasPendingUserInput) {
    return "waiting_for_input";
  }
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return "failed";
  }
  const isRunning =
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.latestTurn?.state === "running";
  if (
    isStaleRunningTurn({
      isRunning,
      lastActivityAt: thread.session?.updatedAt ?? thread.updatedAt,
      now,
    })
  ) {
    return "stale";
  }
  if (thread.session?.status === "starting") {
    return "starting";
  }
  if (thread.session?.status === "running" || thread.latestTurn?.state === "running") {
    return "running";
  }
  if (thread.latestTurn?.state === "completed") {
    return "completed";
  }
  return null;
}

function headlineForPhase(phase: AgentAwarenessPhase): string {
  switch (phase) {
    case "starting":
      return "Starting agent";
    case "running":
      return "Agent is working";
    case "waiting_for_approval":
      return "Approval needed";
    case "waiting_for_input":
      return "Waiting for input";
    case "completed":
      return "Agent finished";
    case "failed":
      return "Agent failed";
    case "stale":
      return "Stopped reporting";
  }
}

function detailForPhase(
  phase: AgentAwarenessPhase,
  thread: ProjectThreadAwarenessInput["thread"],
): string | undefined {
  if (phase === "failed") {
    return thread.session?.lastError ?? undefined;
  }
  if (phase === "completed") {
    return "Review the completed task.";
  }
  if (phase === "running" && thread.session?.providerName) {
    return `${thread.session.providerName} is active.`;
  }
  if (phase === "stale") {
    return "Marked running but silent for over an hour — most likely the turn died. Interrupting it or sending a new message clears it.";
  }
  return undefined;
}
