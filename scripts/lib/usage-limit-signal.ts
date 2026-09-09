// @effect-diagnostics globalDate:off - Standalone watchdog process, no Effect runtime.
/**
 * usage-limit-signal - Decide whether a stopped conversation stopped because
 * the account ran out of budget, and if so, when the budget comes back.
 *
 * The only durable trace of a usage limit is the provider's own prose, stored
 * verbatim as the failing turn's runtime error ("You've hit your session limit
 * · resets 3:40am (Europe/Oslo)"). Nothing structured survives the restart, so
 * this module is the whole detection story and it has to be strict: anything it
 * cannot read with certainty must come back as `null`, because the caller's
 * response to a positive match is to spend money.
 */

/** A provider message that we are confident means "out of budget until X". */
export interface UsageLimitSignal {
  /** Wording family the message matched, kept in artefacts so a miss is diagnosable. */
  readonly dialect: "claude-session-limit" | "codex-usage-limit";
  /** Wall-clock reset the provider named, e.g. `3:40am`. */
  readonly resetsAtText: string;
  /** IANA zone the provider named, or null when it named none. */
  readonly timeZone: string | null;
  /** True when the provider named no zone (or an unusable one) and host local time was assumed. */
  readonly timeZoneAssumed: boolean;
  /** Absolute instant the limit lifts, resolved against the moment the error happened. */
  readonly resetsAt: Date;
}

/**
 * Messages that name a limit at all. Checked before the time patterns so that
 * an unrelated error mentioning "resets" can never be read as a usage limit.
 */
const LIMIT_PHRASE = /you'?ve hit your\s+(?:[a-z0-9-]+\s+)*limit/i;

/** Claude: `You've hit your session limit · resets 3:40am (Europe/Oslo)` */
const CLAUDE_RESET = /\bresets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b\s*(?:\(([^)]+)\))?/i;

/** Codex: `... or try again at 1:41 PM.` */
const CODEX_RESET = /\btry again at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;

/** The furthest ahead a named wall-clock reset is allowed to land. */
const MAX_RESET_HORIZON_MS = 24 * 60 * 60 * 1000;

function toTwentyFourHour(hour: number, meridiem: string): number | null {
  if (hour < 1 || hour > 12) return null;
  const base = hour % 12;
  return meridiem.toLowerCase() === "pm" ? base + 12 : base;
}

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** Offset of `timeZone` from UTC in ms at a given instant (positive east of UTC). */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Turn a wall-clock reading in a zone into an instant.
 *
 * Done in two passes because the offset depends on the instant we are trying to
 * find: the first pass gets within an hour, the second corrects it when the
 * guess landed on the far side of a DST change.
 */
function instantForWallClock(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstOffset = zoneOffsetMs(new Date(naive), timeZone);
  const firstGuess = naive - firstOffset;
  const secondOffset = zoneOffsetMs(new Date(firstGuess), timeZone);
  return secondOffset === firstOffset ? firstGuess : naive - secondOffset;
}

function isUsableTimeZone(timeZone: string): boolean {
  try {
    const probe = new Intl.DateTimeFormat("en-US", { timeZone });
    return probe.resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

/**
 * The provider names a time of day but never a date, so "3:40am" means the next
 * 3:40am after the failure. A reset more than a day out is not something this
 * wording can express, so it is treated as unreadable rather than guessed at.
 */
function resolveNextOccurrence(
  failedAt: Date,
  timeZone: string,
  hour24: number,
  minute: number,
): Date | null {
  const local = zonedParts(failedAt, timeZone);
  let instant = instantForWallClock(timeZone, local.year, local.month, local.day, hour24, minute);
  if (instant <= failedAt.getTime()) {
    const nextDay = new Date(Date.UTC(local.year, local.month - 1, local.day) + 86_400_000);
    instant = instantForWallClock(
      timeZone,
      nextDay.getUTCFullYear(),
      nextDay.getUTCMonth() + 1,
      nextDay.getUTCDate(),
      hour24,
      minute,
    );
  }
  if (instant <= failedAt.getTime()) return null;
  if (instant - failedAt.getTime() > MAX_RESET_HORIZON_MS) return null;
  return new Date(instant);
}

/**
 * Read a provider error as a usage limit, or return null.
 *
 * Null covers three different situations on purpose - not a limit message, a
 * limit message with no readable reset, and a reset that resolves to nonsense -
 * because the caller treats all three the same way: leave the conversation
 * alone.
 */
export function parseUsageLimitSignal(
  message: string | null | undefined,
  failedAt: Date,
): UsageLimitSignal | null {
  if (!message || !LIMIT_PHRASE.test(message)) return null;
  if (!Number.isFinite(failedAt.getTime())) return null;

  const claude = CLAUDE_RESET.exec(message);
  const codex = claude ? null : CODEX_RESET.exec(message);
  const match = claude ?? codex;
  if (!match) return null;

  const hour24 = toTwentyFourHour(Number(match[1]), match[3] ?? "");
  if (hour24 === null) return null;
  const minute = match[2] ? Number(match[2]) : 0;
  if (minute > 59) return null;

  const namedZone = claude ? (match[4]?.trim() ?? null) : null;
  const zoneIsUsable = namedZone !== null && isUsableTimeZone(namedZone);
  const timeZone = zoneIsUsable
    ? (namedZone as string)
    : Intl.DateTimeFormat().resolvedOptions().timeZone;

  const resetsAt = resolveNextOccurrence(failedAt, timeZone, hour24, minute);
  if (!resetsAt) return null;

  return {
    dialect: claude ? "claude-session-limit" : "codex-usage-limit",
    resetsAtText: `${match[1]}${match[2] ? `:${match[2]}` : ""}${(match[3] ?? "").toLowerCase()}`,
    timeZone: zoneIsUsable ? namedZone : null,
    timeZoneAssumed: !zoneIsUsable,
    resetsAt,
  };
}
