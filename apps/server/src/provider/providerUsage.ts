/**
 * providerUsage — shared helpers for normalizing provider plan usage.
 *
 * Both providers that expose plan rate limits push *sparse* updates:
 *
 *  - Claude's `rate_limit_event` carries a single window
 *    (`rate_limit_info.rateLimitType`) and says nothing about the others.
 *  - Codex's `account/rateLimits/updated` is documented as a "sparse rolling
 *    update" whose nullable fields mean "unchanged", not "cleared".
 *
 * So neither provider's push may *replace* the snapshot's usage — both must
 * merge into the last known value. `mergeProviderUsage` is that single merge
 * rule, shared rather than reimplemented per provider, keyed on
 * `ServerProviderUsageWindow.id`.
 *
 * Everything here is pure: normalizers run against `Schema.Unknown` payloads
 * off the wire, so they read structurally and never throw.
 *
 * @module provider/providerUsage
 */
import type { ServerProviderUsage, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * Epoch timestamps below this are unambiguously seconds, not milliseconds:
 * 1e12 milliseconds is 2001-09-09, while 1e12 seconds is the year 33658. Both
 * providers document `resetsAt` as an integer epoch without a unit, and both
 * have shipped seconds in practice, so probe the magnitude instead of
 * trusting either.
 */
const EPOCH_MILLISECONDS_THRESHOLD = 1e12;

export const readRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const readFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const readNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Clamp a reported utilization into the contract's `0`–`100` range.
 *
 * Out-of-range values are clamped rather than dropped: a provider reporting
 * `101` means "the window is spent", and discarding the window entirely
 * would render as "no limit" in the UI — the opposite of the truth.
 */
export const clampUsagePercent = (value: unknown): number | null => {
  const numeric = readFiniteNumber(value);
  if (numeric === undefined) return null;
  return Math.min(100, Math.max(0, numeric));
};

/**
 * Format an untrusted `DateTime.Input` to ISO 8601, or `null` if it isn't a
 * representable instant. `DateTime.make` is the Option-returning constructor,
 * so an unparseable value degrades to "no reset time" instead of putting
 * `"Invalid Date"` into the contract.
 */
const formatIsoOrNull = (input: DateTime.DateTime.Input): string | null =>
  Option.match(DateTime.make(input), {
    onNone: () => null,
    onSome: (dateTime) => DateTime.formatIso(dateTime),
  });

/** Normalize an epoch `resetsAt` (seconds or milliseconds) to ISO 8601. */
export const epochToIsoDateTime = (value: unknown): string | null => {
  const numeric = readFiniteNumber(value);
  if (numeric === undefined || numeric <= 0) return null;
  const milliseconds =
    numeric < EPOCH_MILLISECONDS_THRESHOLD ? Math.round(numeric * 1000) : Math.round(numeric);
  return formatIsoOrNull(milliseconds);
};

/** Normalize an already-ISO `resetsAt` string, rejecting unparseable values. */
export const isoStringToIsoDateTime = (value: unknown): string | null => {
  const raw = readNonEmptyString(value);
  return raw === undefined ? null : formatIsoOrNull(raw);
};

/**
 * Build a window, omitting `severity` and `windowMinutes` entirely when
 * unknown so the encoded snapshot matches the `optionalKey` contract instead
 * of carrying `undefined` values.
 */
export const makeUsageWindow = (input: {
  readonly id: string;
  readonly label: string;
  readonly percent: number | null;
  readonly resetsAt: string | null;
  readonly severity?: ServerProviderUsageWindow["severity"];
  readonly windowMinutes?: number | undefined;
}): ServerProviderUsageWindow => ({
  id: input.id,
  label: input.label,
  percent: input.percent,
  resetsAt: input.resetsAt,
  ...(input.severity ? { severity: input.severity } : {}),
  ...(input.windowMinutes !== undefined &&
  Number.isFinite(input.windowMinutes) &&
  input.windowMinutes > 0
    ? { windowMinutes: input.windowMinutes }
    : {}),
});

/**
 * Merge one window's update onto what was already known about it.
 *
 * "Sparse" reaches inside the window, not just the array: a push routinely
 * names a window and then declines to say how full it is — every observed
 * session-window push from Claude does exactly that. Overwriting a known
 * percentage with that absence blanks the meter until the next full probe,
 * which reads to the user as the number randomly disappearing and coming back.
 *
 * So an absent field means unchanged here too, and only `severity` is allowed
 * to clear: it describes the state of the latest observation, and a stale
 * warning is worse than none.
 */
const mergeUsageWindow = (
  previous: ServerProviderUsageWindow | undefined,
  next: ServerProviderUsageWindow,
): ServerProviderUsageWindow => {
  if (previous === undefined) return next;

  const percent = next.percent ?? previous.percent;
  const resetsAt = next.resetsAt ?? previous.resetsAt;
  const windowMinutes = next.windowMinutes ?? previous.windowMinutes;

  return {
    id: next.id,
    label: next.label,
    percent,
    resetsAt,
    ...(next.severity ? { severity: next.severity } : {}),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
  };
};

/**
 * Merge a sparse provider usage update into the last known usage.
 *
 * Rules:
 *  - Windows are merged by `id`; a window absent from `next` keeps its
 *    previous value, and so does a *field* absent from a window that is
 *    present (absent means "unchanged", never "cleared"). See
 *    `mergeUsageWindow`.
 *  - Previous window order is preserved so the UI doesn't reshuffle on each
 *    push; genuinely new windows append.
 *  - `planLabel` falls back to the previous value — sparse pushes routinely
 *    omit plan metadata, and dropping it would blank the plan on hover.
 *  - `capturedAt`/`source` always come from `next`: they describe the
 *    freshest observation, which is what staleness checks care about. Older
 *    merged-through windows are therefore stamped optimistically.
 *  - An `available: false` update replaces outright — plan limits ceasing to
 *    apply invalidates every window that came before it.
 */
export const mergeProviderUsage = (
  previous: ServerProviderUsage | undefined,
  next: ServerProviderUsage,
): ServerProviderUsage => {
  if (previous === undefined || !previous.available || !next.available) {
    return next;
  }

  const windowsById = new Map(previous.windows.map((window) => [window.id, window]));
  for (const window of next.windows) {
    windowsById.set(window.id, mergeUsageWindow(windowsById.get(window.id), window));
  }

  return {
    available: true,
    planLabel: next.planLabel ?? previous.planLabel,
    windows: [...windowsById.values()],
    capturedAt: next.capturedAt,
    source: next.source,
    ...(next.message ? { message: next.message } : {}),
  };
};
