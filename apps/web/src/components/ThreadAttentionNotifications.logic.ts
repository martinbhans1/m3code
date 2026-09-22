import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { resolveThreadStatusPill, type ThreadStatusInput } from "./Sidebar.logic";

/**
 * Deciding which threads deserve an OS notification, and when.
 *
 * The classification deliberately runs through {@link resolveThreadStatusPill}
 * so a notification can never disagree with the dot the sidebar is showing for
 * the same thread. Only the states that are genuinely waiting on the user are
 * notifiable — a thread that is merely working, connecting, or stalled says
 * nothing, because none of those are news the user can act on.
 */
export type ThreadAttentionKind = "input-needed" | "failed" | "completed";

export interface ThreadAttentionSignal {
  readonly kind: ThreadAttentionKind;
  readonly headline: string;
  /**
   * Identity of the event behind the signal. Two evaluations that produce the
   * same signature describe the same news, so only a change fires a toast.
   */
  readonly signature: string;
}

export interface ThreadAttentionCandidate {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly projectTitle: string;
  readonly archivedAt: string | null;
  readonly thread: ThreadStatusInput;
}

export interface ThreadAttentionPreferences {
  readonly enabled: boolean;
  readonly turnCompleted: boolean;
  readonly inputNeeded: boolean;
  readonly failure: boolean;
  readonly suppressWhenFocused: boolean;
}

export interface ThreadAttentionNotification {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly kind: ThreadAttentionKind;
  readonly title: string;
  readonly body: string;
}

export interface ThreadAttentionEvaluation {
  readonly notifications: readonly ThreadAttentionNotification[];
  /** Thread key → signature, carried into the next evaluation. */
  readonly state: ReadonlyMap<string, string>;
}

/** Recorded for threads with nothing to say, so the next signal is a change. */
const QUIET_SIGNATURE = "";

const UNTITLED_THREAD_TITLE = "Untitled thread";

export function resolveThreadAttentionSignal(
  candidate: ThreadAttentionCandidate,
  now: number,
): ThreadAttentionSignal | null {
  if (candidate.archivedAt) return null;

  const thread = candidate.thread;
  // Turn identity, so a second failure or a second completed turn reads as new
  // news while the same one re-rendering does not.
  const turnKey = thread.latestTurn?.turnId ?? "";

  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return {
      kind: "failed",
      headline: "Agent failed",
      signature: `failed:${turnKey || (thread.session?.updatedAt ?? "")}`,
    };
  }

  const pill = resolveThreadStatusPill({ thread, now });
  switch (pill?.label) {
    case "Pending Approval":
      return {
        kind: "input-needed",
        headline: "Approval needed",
        signature: `approval:${turnKey}`,
      };
    case "Awaiting Input":
      return {
        kind: "input-needed",
        headline: "Waiting for your answer",
        signature: `input:${turnKey}`,
      };
    case "Plan Ready":
      return {
        kind: "input-needed",
        headline: "Plan ready for review",
        signature: `plan:${turnKey}`,
      };
    case "Completed":
      return {
        kind: "completed",
        headline: "Agent finished",
        signature: `completed:${thread.latestTurn?.completedAt ?? turnKey}`,
      };
    default:
      return null;
  }
}

export function isThreadAttentionKindEnabled(
  preferences: ThreadAttentionPreferences,
  kind: ThreadAttentionKind,
): boolean {
  switch (kind) {
    case "completed":
      return preferences.turnCompleted;
    case "input-needed":
      return preferences.inputNeeded;
    case "failed":
      return preferences.failure;
  }
}

/**
 * A notification is pointless when the user is demonstrably already looking at
 * the thread it is about, and optionally whenever the app has focus at all.
 */
export function isThreadAttentionSuppressed(input: {
  readonly candidateKey: string;
  readonly activeThreadKey: string | null;
  readonly windowFocused: boolean;
  readonly preferences: ThreadAttentionPreferences;
}): boolean {
  if (!input.windowFocused) return false;
  return input.preferences.suppressWhenFocused || input.activeThreadKey === input.candidateKey;
}

export function evaluateThreadAttentionNotifications(input: {
  readonly candidates: readonly ThreadAttentionCandidate[];
  readonly previous: ReadonlyMap<string, string>;
  readonly preferences: ThreadAttentionPreferences;
  readonly activeThreadKey: string | null;
  readonly windowFocused: boolean;
  readonly now: number;
}): ThreadAttentionEvaluation {
  const state = new Map<string, string>();
  const notifications: ThreadAttentionNotification[] = [];

  for (const candidate of input.candidates) {
    const signal = resolveThreadAttentionSignal(candidate, input.now);
    const signature = signal?.signature ?? QUIET_SIGNATURE;
    const previous = input.previous.get(candidate.key);
    // Recorded before any of the reasons to stay quiet, so a suppressed or
    // disabled signal is treated as seen rather than announced later out of
    // context — including the first sighting of a thread, which a bootstrap or
    // a reconnect replays for every thread at once and is never new news.
    state.set(candidate.key, signature);

    if (signal === null) continue;
    if (previous === undefined || previous === signature) continue;
    if (!input.preferences.enabled) continue;
    if (!isThreadAttentionKindEnabled(input.preferences, signal.kind)) continue;
    if (
      isThreadAttentionSuppressed({
        candidateKey: candidate.key,
        activeThreadKey: input.activeThreadKey,
        windowFocused: input.windowFocused,
        preferences: input.preferences,
      })
    ) {
      continue;
    }

    notifications.push({
      key: candidate.key,
      environmentId: candidate.environmentId,
      threadId: candidate.threadId,
      kind: signal.kind,
      title: candidate.threadTitle.trim() || UNTITLED_THREAD_TITLE,
      body: `${signal.headline} · ${candidate.projectTitle}`,
    });
  }

  return { notifications, state };
}
