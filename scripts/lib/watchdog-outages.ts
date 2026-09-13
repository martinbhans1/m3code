// @effect-diagnostics globalDate:off - Standalone watchdog process, no Effect runtime.
/**
 * watchdog-outages - What it cost that the watchdog cannot start the app.
 *
 * The watchdog delivers its wake-up through the running app, so if the app has
 * crashed there is nothing it can do. It does not relaunch the app: on
 * 2026-09-13 Martin decided relaunching stays manual, including after a crash.
 *
 * The point of this module is that the price of that decision stays a measured
 * number rather than a hypothetical. Every scan that finds the app down is recorded,
 * along with how many conversations were sitting there restartable at that
 * moment, so "should the watchdog be allowed to relaunch the app" can be
 * answered with "it would have saved four nights in a month" or "it has never
 * once mattered".
 */

export interface Outage {
  readonly startedAt: string;
  readonly lastSeenAt: string;
  /** How many scans found the app down during this stretch. */
  readonly scans: number;
  /**
   * The most conversations seen waiting on a lifted limit during the stretch -
   * work that would have been restarted had the app been up.
   */
  readonly missedRestarts: number;
}

/** Scans are five minutes apart; a bigger gap than this is a separate outage. */
const SAME_OUTAGE_WINDOW_MS = 20 * 60_000;

/**
 * Fold one "the app was down" observation into the record.
 *
 * Consecutive scans collapse into a single stretch, because what matters is
 * how many nights were lost, not how many times we looked.
 */
export function recordOutage(
  outages: readonly Outage[],
  at: Date,
  missedRestarts: number,
): readonly Outage[] {
  const last = outages.at(-1);
  const isContinuation =
    last !== undefined &&
    at.getTime() - new Date(last.lastSeenAt).getTime() <= SAME_OUTAGE_WINDOW_MS;
  if (!isContinuation) {
    return [
      ...outages.slice(-200),
      { startedAt: at.toISOString(), lastSeenAt: at.toISOString(), scans: 1, missedRestarts },
    ];
  }
  return [
    ...outages.slice(0, -1),
    {
      startedAt: last.startedAt,
      lastSeenAt: at.toISOString(),
      scans: last.scans + 1,
      missedRestarts: Math.max(last.missedRestarts, missedRestarts),
    },
  ];
}

export interface OutageSummary {
  readonly stretches: number;
  readonly totalMinutes: number;
  readonly missedRestarts: number;
  readonly since: string | null;
}

export function summariseOutages(
  outages: readonly Outage[],
  now: Date,
  windowMs = 30 * 24 * 60 * 60_000,
): OutageSummary {
  const recent = outages.filter(
    (outage) => now.getTime() - new Date(outage.lastSeenAt).getTime() <= windowMs,
  );
  const totalMs = recent.reduce(
    (total, outage) =>
      total + (new Date(outage.lastSeenAt).getTime() - new Date(outage.startedAt).getTime()),
    0,
  );
  return {
    stretches: recent.length,
    totalMinutes: Math.round(totalMs / 60_000),
    missedRestarts: recent.reduce((total, outage) => total + outage.missedRestarts, 0),
    since: recent.at(0)?.startedAt ?? null,
  };
}

/**
 * One paragraph for the status output.
 *
 * Deliberately states the consequence, not the event: "the app was down" is a
 * fact about a process, "nothing was restarted for six hours" is the thing
 * worth deciding about.
 */
export function formatOutages(summary: OutageSummary): string {
  if (summary.stretches === 0) {
    return "The app has been up every time the watchdog looked, so nothing has been lost to it being down.\n";
  }
  const hours = (summary.totalMinutes / 60).toFixed(1);
  const cost =
    summary.missedRestarts > 0
      ? `${summary.missedRestarts} conversation(s) were sitting there restartable while it was down.`
      : "No conversation was waiting on a lifted limit during those stretches, so nothing was actually lost.";
  return [
    `App down, watchdog unable to do anything: ${summary.stretches} stretch(es) in the last 30 days, about ${hours} hours in total.`,
    cost,
    "Relaunching the app stays manual by decision, so the watchdog only records this.",
    "",
  ].join("\n");
}
