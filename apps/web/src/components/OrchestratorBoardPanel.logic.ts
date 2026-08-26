import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";

/**
 * The orchestrator's status board: every conversation it can currently see,
 * grouped by what each one needs from you.
 *
 * The grouping is the point. "Four conversations idle" is not actionable;
 * "one wants an approval, one asked a question, two are done" is. Threads sort
 * by how much they are blocking you, not by when they last moved — the thing
 * that has been stuck longest is the thing most likely to have been forgotten.
 */

export type BoardGroupId = "needsYou" | "stalled" | "working" | "settled";

export interface BoardRow {
  readonly thread: SidebarThreadSummary;
  readonly projectTitle: string;
  readonly access: "watch" | "control";
  readonly group: BoardGroupId;
  /**
   * Why it is in that group — but only when the status dot beside it does not
   * already say so. Repeating "Working" next to a dot labelled "Working" costs
   * the one line that could have said when.
   */
  readonly detail: string | null;
  /** When something last happened, phrased for the group it landed in. */
  readonly timing: string | null;
}

export const GROUP_ORDER: ReadonlyArray<{
  readonly id: BoardGroupId;
  readonly title: string;
  readonly emptyHint: string;
}> = [
  {
    id: "needsYou",
    title: "Needs you",
    emptyHint: "Nothing is blocked on you.",
  },
  { id: "stalled", title: "Stalled", emptyHint: "Nothing has stalled." },
  { id: "working", title: "Working", emptyHint: "Nothing is running." },
  { id: "settled", title: "Settled", emptyHint: "Nothing finished yet." },
];

/** Where each of the sidebar's status labels belongs on the board. */
const GROUP_BY_PILL_LABEL: Record<ThreadStatusPill["label"], BoardGroupId> = {
  "Pending Approval": "needsYou",
  "Awaiting Input": "needsYou",
  "Plan Ready": "needsYou",
  Stalled: "stalled",
  Working: "working",
  Connecting: "working",
  Completed: "settled",
};

/**
 * Delegates to `resolveThreadStatusPill` — the same derivation the sidebar rows
 * use — rather than restating its precedence.
 *
 * An earlier version of this duplicated the ladder and drifted immediately: it
 * grew branches for a running *turn* and for errors that the pill has no
 * equivalent of, so a thread with a stale running turn row and a dead session
 * read as "Working" here and as nothing at all in the sidebar. Two views
 * disagreeing about the same conversation is worse than either being sparse.
 *
 * What is added on top is only what the pill returns `null` for and a board
 * must not silently drop.
 */
export function classifyThread(thread: SidebarThreadSummary): {
  group: BoardGroupId;
  detail: string | null;
} {
  const pill = resolveThreadStatusPill({ thread });
  // No detail: the dot beside the title is already labelled with exactly this.
  if (pill !== null) return { group: GROUP_BY_PILL_LABEL[pill.label], detail: null };

  // The pill has no colour for a failed thread, but it is the case most worth
  // surfacing.
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return { group: "needsYou", detail: "Failed" };
  }
  // Stopped mid-work and never returned to. Nothing in the UI nags about this,
  // which is exactly why it belongs at the top rather than filed under "done".
  if (thread.latestTurn?.state === "interrupted") {
    return { group: "needsYou", detail: "Interrupted, never resumed" };
  }
  if (thread.hasPendingFollowups) return { group: "settled", detail: "Open follow-ups" };
  if (thread.latestTurn === null) return { group: "settled", detail: "Never run" };
  return { group: "settled", detail: null };
}

/**
 * When something last happened, phrased for what the group means.
 *
 * "Awaiting Input" without a time is only half an answer — a question asked two
 * minutes ago and one asked on Tuesday need very different things from you, and
 * the board exists precisely to tell those apart at a glance.
 */
export function timingFor(thread: SidebarThreadSummary, group: BoardGroupId): string | null {
  const startedAt = thread.latestTurn?.startedAt ?? null;
  const completedAt = thread.latestTurn?.completedAt ?? null;
  const lastMoved = thread.session?.updatedAt ?? thread.updatedAt ?? null;

  switch (group) {
    case "working":
      return startedAt === null ? null : `running ${formatElapsedDurationLabel(startedAt)}`;
    case "stalled":
      return lastMoved === null ? null : `silent for ${formatElapsedDurationLabel(lastMoved)}`;
    case "needsYou":
      return lastMoved === null ? null : `waiting ${formatElapsedDurationLabel(lastMoved)}`;
    case "settled": {
      const settledAt = completedAt ?? thread.updatedAt ?? null;
      return settledAt === null ? null : formatRelativeTimeLabel(settledAt);
    }
  }
}

/**
 * The message the board puts in the composer for a row, or null when there is
 * nothing obvious to say about it.
 *
 * These are the sentences you would have typed anyway. Writing them for you is
 * the difference between the board being somewhere you look and somewhere you
 * work from — and each one is a request, not an action, so the orchestrator
 * still confirms anything it would change.
 */
export function primaryActionFor(
  row: BoardRow,
): { readonly label: string; readonly prompt: string } | null {
  const name = `"${row.thread.title}"`;
  if (row.thread.hasPendingApprovals) {
    return {
      label: "Ask what it wants to run",
      prompt: `What is ${name} waiting for approval to do? Show me the command or edit, then tell me whether to allow it.`,
    };
  }
  if (row.thread.hasPendingUserInput) {
    return {
      label: "Show me the question",
      prompt: `Show me the question ${name} is asking, with its options, so I can answer it from here.`,
    };
  }
  if (row.group === "stalled") {
    return {
      label: "Clear the dead turn",
      prompt: `The turn in ${name} has been marked running but silent for a long time. Check what it actually got done, then stop the turn so the conversation is usable again.`,
    };
  }
  if (row.group === "working") {
    return {
      label: "Catch me up",
      prompt: `What is ${name} doing right now, and how far along is it?`,
    };
  }
  return {
    label: "What did it change?",
    prompt: `What did ${name} actually change on disk? Check the files rather than what it said it did.`,
  };
}
