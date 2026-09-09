// @effect-diagnostics globalDate:off - Standalone watchdog process, no Effect runtime.
/**
 * watchdog-decide - Whether to wake anything up, and if so, exactly one thing.
 *
 * Pure on purpose. The watchdog's failure mode is not "misses a restart", it is
 * "restarts in a loop and eats the budget it exists to protect", so every rule
 * that stops it acting lives here where it can be tested against a fabricated
 * night rather than a real one.
 *
 * Three ideas do the safety work:
 *  - a conversation is only ever a candidate if its own last turn died with a
 *    usage-limit message we could read a reset time out of;
 *  - at most one conversation is woken per scan, and the next one waits until
 *    the previous one visibly moved, so a limit that has not really lifted
 *    costs one nudge rather than five;
 *  - hard caps per conversation, per window and per day, counted from the
 *    ledger on disk, which survives this process being killed.
 */
import { parseUsageLimitSignal, type UsageLimitSignal } from "./usage-limit-signal.ts";
import type { Snapshot, ThreadObservation } from "./watchdog-observe.ts";
import type { LedgerEntry } from "./watchdog-store.ts";

export interface WatchdogLimits {
  /** Wait this long past the named reset before believing the budget is back. */
  readonly graceAfterResetMs: number;
  /** Nudges allowed per conversation per reset window. */
  readonly maxAttemptsPerWindow: number;
  /** Never nudge the same conversation twice inside this. */
  readonly minMsBetweenThreadNudges: number;
  /** Rolling spend caps, counted from the ledger. */
  readonly maxNudgesPerSixHours: number;
  readonly maxNudgesPerDay: number;
  /** More stalled conversations than this means something systemic; refuse to act. */
  readonly maxStalledThreads: number;
  /**
   * Ignore failures older than this. The watchdog is for recovering a night, not
   * for reviving last week: by the time a stall is half a day old Martin has
   * seen it, and restarting it unasked is a surprise rather than a rescue.
   */
  readonly maxFailureAgeMs: number;
  /** How long to wait for a woken conversation to show life before moving on. */
  readonly canaryProgressTimeoutMs: number;
}

export const DEFAULT_LIMITS: WatchdogLimits = {
  graceAfterResetMs: 2 * 60_000,
  maxAttemptsPerWindow: 2,
  minMsBetweenThreadNudges: 20 * 60_000,
  maxNudgesPerSixHours: 8,
  maxNudgesPerDay: 20,
  maxStalledThreads: 12,
  maxFailureAgeMs: 12 * 60 * 60_000,
  canaryProgressTimeoutMs: 30 * 60_000,
};

export type VerdictKind = "restart" | "hold" | "ignore";

export interface ThreadVerdict {
  readonly threadId: string;
  readonly title: string;
  readonly projectTitle: string | null;
  readonly isOrchestrator: boolean;
  readonly providerInstanceId: string | null;
  readonly verdict: VerdictKind;
  readonly reason: string;
  readonly failedAt: string | null;
  readonly limitMessage: string | null;
  readonly resetsAt: string | null;
  readonly attemptsThisWindow: number;
}

export interface NudgeAction {
  readonly kind: "nudge";
  readonly threadId: string;
  readonly title: string;
  readonly projectTitle: string | null;
  readonly isOrchestrator: boolean;
  readonly providerInstanceId: string | null;
  readonly resetWindow: string;
  readonly attempt: number;
  readonly message: string;
}

export interface NoAction {
  readonly kind: "none";
  readonly reason: string;
}

export interface ScanDecision {
  readonly action: NudgeAction | NoAction;
  readonly verdicts: readonly ThreadVerdict[];
  readonly waitingUntil: string | null;
  readonly limits: WatchdogLimits;
}

interface Candidate {
  readonly thread: ThreadObservation;
  readonly signal: UsageLimitSignal;
  readonly failedAt: Date;
  readonly attemptsThisWindow: number;
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function isAfter(a: string | null, b: Date): boolean {
  const parsed = toDate(a);
  return parsed !== null && parsed.getTime() > b.getTime();
}

function nudgesSince(ledger: readonly LedgerEntry[], since: number): number {
  return ledger.filter(
    (entry) => entry.outcome === "sent" && new Date(entry.at).getTime() >= since,
  ).length;
}

/**
 * The wording of the wake-up.
 *
 * It has to do two jobs at once: tell the conversation it was cut off rather
 * than finished, and give it an explicit way to stop. A conversation that had
 * actually finished must be able to answer in one line and go quiet, otherwise
 * the watchdog turns every completed thread it misreads into new spend.
 */
export function buildNudgeMessage(
  thread: ThreadObservation,
  signal: UsageLimitSignal,
  failedAt: Date,
): string {
  const stoppedAt = failedAt.toISOString();
  const supervision = thread.isOrchestrator
    ? " You supervise other conversations, so restart your supervision as part of this: check what each one you were watching is doing now before deciding anything."
    : "";
  return [
    `[usage-limit watchdog] This conversation stopped at ${stoppedAt} because the account hit its limit, not because the work finished. The provider said the limit resets ${signal.resetsAtText}, and that time has now passed.`,
    `Pick the work back up: re-read your last few messages, check what actually landed on disk and in git, and continue from there.${supervision}`,
    "If the work was in fact already finished, reply with one line saying so and stop - do not start anything new on the strength of this message.",
  ].join("\n\n");
}

/** Classify one conversation, with the reason recorded either way. */
function classify(
  thread: ThreadObservation,
  ledger: readonly LedgerEntry[],
  now: Date,
  limits: WatchdogLimits,
): { readonly verdict: ThreadVerdict; readonly candidate: Candidate | null } {
  const failedAt = toDate(thread.runtimeErrorAt);
  const signal = failedAt ? parseUsageLimitSignal(thread.runtimeErrorMessage, failedAt) : null;
  const base = {
    threadId: thread.threadId,
    title: thread.title,
    projectTitle: thread.projectTitle,
    isOrchestrator: thread.isOrchestrator,
    providerInstanceId: thread.providerInstanceId,
    failedAt: thread.runtimeErrorAt,
    limitMessage: thread.runtimeErrorMessage,
    resetsAt: signal ? signal.resetsAt.toISOString() : null,
    attemptsThisWindow: 0,
  } as const;

  const ignore = (reason: string) => ({
    verdict: { ...base, verdict: "ignore" as const, reason },
    candidate: null,
  });
  const hold = (reason: string, attemptsThisWindow = 0) => ({
    verdict: { ...base, verdict: "hold" as const, reason, attemptsThisWindow },
    candidate: null,
  });

  if (!failedAt) return ignore("no-runtime-error-recorded");
  if (!signal) return ignore("last-failure-is-not-a-readable-usage-limit");
  if (now.getTime() - failedAt.getTime() > limits.maxFailureAgeMs) {
    return ignore("stalled-too-long-ago-to-resume-unattended");
  }
  if (thread.doneAt) return ignore("conversation-marked-done");
  // A conversation waiting on an approval or a question needs an answer, not a
  // new turn, and the watchdog is not entitled to give it one.
  if (thread.pendingApprovalCount > 0) return ignore("waiting-on-an-approval");
  if (thread.pendingUserInputCount > 0) return ignore("waiting-on-an-answer");
  if (thread.archivedAt) return ignore("conversation-archived");
  if (thread.sessionStatus === "running" || thread.sessionStatus === "starting") {
    return ignore("already-running");
  }
  if (
    thread.runtimeErrorTurnId !== null &&
    thread.latestTurn?.turnId !== null &&
    thread.runtimeErrorTurnId !== thread.latestTurn?.turnId
  ) {
    return ignore("failure-belongs-to-an-older-turn");
  }
  if (isAfter(thread.latestUserMessageAt, failedAt)) return ignore("someone-replied-since");
  if (isAfter(thread.newestTurnRequestedAt, failedAt)) return ignore("work-already-restarted");

  const resetWindow = signal.resetsAt.toISOString();
  const threadEntries = ledger.filter(
    (entry) => entry.threadId === thread.threadId && entry.outcome === "sent",
  );
  const attemptsThisWindow = threadEntries.filter(
    (entry) => entry.resetWindow === resetWindow,
  ).length;

  if (now.getTime() < signal.resetsAt.getTime() + limits.graceAfterResetMs) {
    return hold("waiting-for-the-reset-time", attemptsThisWindow);
  }
  if (attemptsThisWindow >= limits.maxAttemptsPerWindow) {
    return hold("attempt-cap-for-this-reset-window", attemptsThisWindow);
  }
  const lastNudgeAt = threadEntries
    .map((entry) => new Date(entry.at).getTime())
    .reduce((latest, at) => Math.max(latest, at), 0);
  if (lastNudgeAt > 0 && now.getTime() - lastNudgeAt < limits.minMsBetweenThreadNudges) {
    return hold("nudged-too-recently", attemptsThisWindow);
  }

  return {
    verdict: { ...base, verdict: "restart", reason: "stopped-by-usage-limit-that-has-lifted", attemptsThisWindow },
    candidate: { thread, signal, failedAt, attemptsThisWindow },
  };
}

/**
 * Did the conversation we woke last actually wake up?
 *
 * Absence from the snapshot is the strongest yes: the snapshot only contains
 * conversations whose newest turn failed, so a woken one that is no longer
 * there has started a turn. Otherwise, any activity newer than the nudge counts
 * - including a fresh failure, which is how "the limit had not really lifted"
 * gets turned back into a wait rather than another nudge.
 */
function previousNudgeProgress(
  snapshot: Snapshot,
  ledger: readonly LedgerEntry[],
  now: Date,
  limits: WatchdogLimits,
): { readonly settled: true } | { readonly settled: false; readonly reason: string } {
  const lastSent = ledger.toReversed().find((entry) => entry.outcome === "sent");
  if (!lastSent) return { settled: true };
  const nudgedAt = new Date(lastSent.at);
  if (!Number.isFinite(nudgedAt.getTime())) return { settled: true };
  if (now.getTime() - nudgedAt.getTime() > limits.canaryProgressTimeoutMs) {
    // Waiting forever on a conversation that never woke would disable the
    // watchdog entirely; the spend caps are what bound us from here.
    return { settled: true };
  }
  const target = snapshot.threads.find((thread) => thread.threadId === lastSent.threadId);
  if (!target) return { settled: true };
  if (isAfter(target.latestActivityAt, nudgedAt)) return { settled: true };
  if (isAfter(target.newestTurnRequestedAt, nudgedAt)) return { settled: true };
  return {
    settled: false,
    reason: `waiting-for-${lastSent.threadId}-to-show-life-after-its-nudge`,
  };
}

export function decide(
  snapshot: Snapshot,
  ledger: readonly LedgerEntry[],
  now: Date,
  overrides: Partial<WatchdogLimits> = {},
): ScanDecision {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const classified = snapshot.threads.map((thread) => classify(thread, ledger, now, limits));
  const verdicts = classified.map((entry) => entry.verdict);
  const candidates = classified
    .map((entry) => entry.candidate)
    .filter((candidate): candidate is Candidate => candidate !== null);

  const waitingUntil = verdicts
    .filter((verdict) => verdict.verdict === "hold" && verdict.resetsAt !== null)
    .map((verdict) => verdict.resetsAt as string)
    .sort()
    .at(0) ?? null;

  const none = (reason: string): ScanDecision => ({
    action: { kind: "none", reason },
    verdicts,
    waitingUntil,
    limits,
  });

  if (!snapshot.serverRunning) return none("app-is-not-running");
  const stalledOnLimits = verdicts.filter(
    (verdict) => verdict.verdict !== "ignore" && verdict.resetsAt !== null,
  ).length;
  if (stalledOnLimits > limits.maxStalledThreads) {
    return none("too-many-conversations-stalled-at-once-refusing-to-act");
  }
  if (candidates.length === 0) return none("nothing-to-restart");
  if (nudgesSince(ledger, now.getTime() - 6 * 60 * 60_000) >= limits.maxNudgesPerSixHours) {
    return none("six-hour-nudge-cap-reached");
  }
  if (nudgesSince(ledger, now.getTime() - 24 * 60 * 60_000) >= limits.maxNudgesPerDay) {
    return none("daily-nudge-cap-reached");
  }
  const progress = previousNudgeProgress(snapshot, ledger, now, limits);
  if (!progress.settled) return none(progress.reason);

  // Supervisors first: whatever they were watching stays stopped until they are.
  const chosen = [...candidates].sort((left, right) => {
    if (left.thread.isOrchestrator !== right.thread.isOrchestrator) {
      return left.thread.isOrchestrator ? -1 : 1;
    }
    return left.failedAt.getTime() - right.failedAt.getTime();
  })[0] as Candidate;

  return {
    action: {
      kind: "nudge",
      threadId: chosen.thread.threadId,
      title: chosen.thread.title,
      projectTitle: chosen.thread.projectTitle,
      isOrchestrator: chosen.thread.isOrchestrator,
      providerInstanceId: chosen.thread.providerInstanceId,
      resetWindow: chosen.signal.resetsAt.toISOString(),
      attempt: chosen.attemptsThisWindow + 1,
      message: buildNudgeMessage(chosen.thread, chosen.signal, chosen.failedAt),
    },
    verdicts,
    waitingUntil,
    limits,
  };
}
