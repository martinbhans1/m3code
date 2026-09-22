/**
 * Where a conversation stands from the user's point of view, as opposed to what
 * its agent is doing right now.
 *
 * The rest of the system models *blocked-ness* — waiting on an approval, on an
 * answer, on a failed turn — which is cheap to derive and always correct. What
 * it does not model is *unfinished-ness*: a thread that shipped something and
 * stopped looks exactly like one that had nothing left to do. At a few threads
 * a week that difference is invisible. At thirty a day the unfinished ones are
 * simply forgotten, because nothing ever puts them back in front of anyone.
 *
 * Two dispositions close that gap, and they are deliberately different kinds of
 * thing:
 *
 * - **done** is a stamp the user applies by hand. It is a judgement only they
 *   can make, and making it explicit is the point — it is how a thread stops
 *   costing attention without being archived out of sight.
 * - **cold** is derived and costs the user nothing. It is the thread nobody
 *   ruled on: quiet for days, with work its own agent already said was left.
 *
 * Both are pure functions of a thread shell, so the sidebar, the orchestrator
 * and mobile all answer the question identically instead of each inventing a
 * rule.
 */

/**
 * How long a conversation has to sit untouched before it counts as cold.
 *
 * Three days rather than one: a thread parked over a weekend, or one you are
 * deliberately coming back to on Monday, is not forgotten and should not be
 * dressed up as a problem. Cold has to stay rare enough to be worth reading.
 */
export const DEFAULT_COLD_THREAD_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The slice of a thread shell the two dispositions are computed from. Declared
 * structurally rather than against `OrchestrationThreadShell` so the mobile and
 * orchestrator projections, which carry their own shapes, can pass what they
 * have without a conversion.
 */
export interface ThreadDispositionInput {
  readonly archivedAt: string | null;
  readonly doneAt: string | null;
  /** Latest point at which anything happened in the thread, ISO-8601. */
  readonly updatedAt: string;
  readonly hasPendingFollowups: boolean;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  /** True while a turn or provider session is in flight. */
  readonly isRunning: boolean;
}

/**
 * Whether a `doneAt` stamp has been overtaken by the user coming back to the
 * thread.
 *
 * Sending a message into a settled conversation is the clearest possible signal
 * that it is not settled any more, so the stamp yields to it rather than making
 * the user remember to lift it by hand. Applied wherever a user message lands,
 * which means a thread the orchestrator writes into un-settles itself too.
 */
export function isDoneStampSuperseded(
  doneAt: string | null,
  latestUserMessageAt: string | null,
): boolean {
  if (doneAt === null || latestUserMessageAt === null) return false;
  return latestUserMessageAt > doneAt;
}

/**
 * Whether a conversation has gone cold: quiet for long enough to have dropped
 * out of the user's head, with work its own agent recorded as still open.
 *
 * Each exclusion is load-bearing:
 *
 * - **Archived or done** — the user has already ruled on it. Re-raising a
 *   thread somebody deliberately put down is how a status surface earns its
 *   way into being ignored.
 * - **Running** — it is mid-turn. Nothing has been forgotten.
 * - **Waiting on an approval or an answer** — already surfaced, loudly, as
 *   something blocking the user. A thread cannot be both forgotten and
 *   shouting; listing it twice makes both lists worth less.
 * - **No pending follow-ups** — this is the one that keeps the list honest.
 *   Without it every old thread qualifies and "cold" degrades into "old",
 *   which the user can already see from a timestamp. A pending follow-up is
 *   the thread's own agent saying, while it still had the context, that there
 *   was a next rung here. That is the signal worth chasing; absence of it
 *   means the thread is finished or abandoned, and archive covers both.
 */
export function isThreadCold(
  thread: ThreadDispositionInput,
  now: number,
  coldAfterMs: number = DEFAULT_COLD_THREAD_AFTER_MS,
): boolean {
  if (thread.archivedAt !== null) return false;
  if (thread.doneAt !== null) return false;
  if (thread.isRunning) return false;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (!thread.hasPendingFollowups) return false;

  const updatedAt = Date.parse(thread.updatedAt);
  if (Number.isNaN(updatedAt)) return false;
  return now - updatedAt >= coldAfterMs;
}

/**
 * How long a conversation has been quiet, in whole days, for labelling a cold
 * thread ("quiet for 6 days"). Null when the timestamp cannot be read.
 */
export function threadQuietDays(updatedAt: string, now: number): number | null {
  const parsed = Date.parse(updatedAt);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.floor((now - parsed) / (24 * 60 * 60 * 1000)));
}
