// @effect-diagnostics globalDate:off - Standalone watchdog process, no Effect runtime.
/**
 * watchdog-abandoned - Conversations that stopped mid-work and were never
 * spoken of again.
 *
 * The watchdog restarts exactly one thing: work stopped by a usage limit that
 * has since lifted. Everything else it leaves alone, deliberately - a crash
 * might have left the repository in a state nobody should resume blind.
 *
 * But "leave it alone" turned into "nobody will ever know". A conversation that
 * died on a crash sits there with real work in it and no surface anywhere says
 * so; one was found this morning that had been dead 29 days. Listing them is
 * the whole fix, and it costs nothing: this decides nothing and starts nothing,
 * it only names what is already sitting there.
 */
import { parseUsageLimitSignal } from "./usage-limit-signal.ts";
import type { ThreadObservation } from "./watchdog-observe.ts";

/** Long enough that today's and yesterday's work never appears here. */
export const DEFAULT_QUIET_MS = 2 * 24 * 60 * 60_000;

export interface AbandonedConversation {
  readonly threadId: string;
  readonly title: string;
  readonly projectTitle: string | null;
  readonly isOrchestrator: boolean;
  readonly quietSince: string;
  readonly quietDays: number;
  /** What the conversation was doing when it stopped, in the app's own words. */
  readonly turnState: string;
  /** Why it stopped, as far as anything was recorded. */
  readonly stoppedBecause: string;
}

function describeStop(thread: ThreadObservation): string {
  const failedAt = thread.runtimeErrorAt ? new Date(thread.runtimeErrorAt) : null;
  const message = thread.runtimeErrorMessage?.trim();
  if (!message) {
    return thread.latestTurn?.state === "error"
      ? "it failed, but nothing recorded why"
      : "the turn never finished - the app was almost certainly killed under it";
  }
  if (failedAt && parseUsageLimitSignal(message, failedAt)) {
    return `a usage limit, too long ago for the watchdog to resume: ${message}`;
  }
  // The adapter repeats the thread id we are already showing; drop the preamble.
  const trimmed = message.replace(
    /^Provider adapter process error \([^)]*\) for thread [0-9a-f-]+:\s*/i,
    "",
  );
  return trimmed.split("\n")[0]?.slice(0, 200) ?? trimmed;
}

/**
 * Conversations left mid-work and silent since.
 *
 * Ordered longest-silent first: the value of the list is the one that has been
 * dead a month, not the one that stopped on Tuesday.
 */
export function findAbandoned(
  threads: readonly ThreadObservation[],
  now: Date,
  quietMs: number = DEFAULT_QUIET_MS,
): readonly AbandonedConversation[] {
  return threads
    .filter((thread) => thread.doneAt === null && thread.archivedAt === null)
    .map((thread) => {
      const quietSince = thread.latestActivityAt ?? thread.threadUpdatedAt;
      const since = new Date(quietSince);
      return { thread, quietSince, silentMs: now.getTime() - since.getTime() };
    })
    .filter((entry) => Number.isFinite(entry.silentMs) && entry.silentMs >= quietMs)
    .sort((left, right) => right.silentMs - left.silentMs)
    .map(({ thread, quietSince, silentMs }) => ({
      threadId: thread.threadId,
      title: thread.title,
      projectTitle: thread.projectTitle,
      isOrchestrator: thread.isOrchestrator,
      quietSince,
      quietDays: Math.floor(silentMs / (24 * 60 * 60_000)),
      turnState: thread.latestTurn?.state ?? "unknown",
      stoppedBecause: describeStop(thread),
    }));
}

/** One line each, for the status output. */
export function formatAbandoned(entries: readonly AbandonedConversation[], limit = 15): string {
  if (entries.length === 0) return "Nothing has been left mid-work and gone quiet.\n";
  const shown = entries.slice(0, limit);
  const lines = shown.map((entry) => {
    const where = entry.projectTitle ? ` [${entry.projectTitle}]` : "";
    return `  ${String(entry.quietDays).padStart(3)}d  ${entry.title}${where}\n         ${entry.stoppedBecause}`;
  });
  const more =
    entries.length > shown.length ? `\n  ...and ${entries.length - shown.length} more.` : "";
  return `Stopped mid-work and quiet since (not restarted - these are yours to judge):\n${lines.join("\n")}${more}\n`;
}
