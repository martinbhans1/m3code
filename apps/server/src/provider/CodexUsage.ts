/**
 * CodexUsage — normalize Codex `RateLimitSnapshot` payloads into
 * `ServerProviderUsage`.
 *
 * Three payloads reach this normalizer, all structurally a `RateLimitSnapshot`
 * behind zero, one, or two levels of `rateLimits` nesting:
 *
 *  1. `V2GetAccountRateLimitsResponse` — `{ rateLimits: {…} }`, the baseline
 *     read at snapshot-probe time.
 *  2. `V2AccountRateLimitsUpdatedNotification` — also `{ rateLimits: {…} }`,
 *     which `CodexAdapter` forwards *whole* as the runtime event's
 *     `payload.rateLimits`, producing `{ rateLimits: { rateLimits: {…} } }`.
 *  3. A bare `RateLimitSnapshot`.
 *
 * Unwrapping structurally rather than by source keeps the caller from having
 * to know which nesting it holds.
 *
 * ## Sparse updates
 *
 * The push notification is documented as a sparse rolling update: "Nullable
 * account metadata may be unavailable in a rolling update and does not clear a
 * previously observed value." A missing `primary`/`secondary`/`planType`
 * therefore means *unchanged*, so this normalizer omits absent windows from
 * `windows[]` (rather than emitting them as null) and leaves `planLabel` null,
 * letting `mergeProviderUsage` restore the previous values by id.
 *
 * @module provider/CodexUsage
 */
import type { ServerProviderUsage, ServerProviderUsageWindow } from "@t3tools/contracts";

import { codexPlanTypeLabel, readCodexPlanType } from "./CodexPlan.ts";
import {
  clampUsagePercent,
  epochToIsoDateTime,
  makeUsageWindow,
  readFiniteNumber,
  readRecord,
} from "./providerUsage.ts";

/**
 * Codex names its windows by precedence (`primary`/`secondary`), not by
 * duration, so the label comes from `windowDurationMins` instead. These are
 * the durations the ChatGPT tiers actually ship.
 */
const CODEX_WINDOW_DURATION_LABELS: ReadonlyMap<number, string> = new Map([
  [60, "Hourly"],
  [300, "5h"],
  [1440, "Daily"],
  [10_080, "Weekly"],
  [43_200, "Monthly"],
]);

/** Fallback labels when `windowDurationMins` is absent from the snapshot. */
const CODEX_WINDOW_FALLBACK_LABELS = {
  primary: "Primary",
  secondary: "Secondary",
} as const;

type CodexWindowId = keyof typeof CODEX_WINDOW_FALLBACK_LABELS;

/** Ordered shortest-window-first, matching how the UI reads them. */
const CODEX_WINDOW_IDS = ["primary", "secondary"] as const satisfies ReadonlyArray<CodexWindowId>;

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;

/**
 * Derive a window label from its duration, e.g. `300` → `"5h"`, `10080` →
 * `"Weekly"`. Unknown durations fall back to a generated `"<n>h"` / `"<n>d"`
 * rather than the opaque `"Primary"`/`"Secondary"`.
 */
export const codexWindowLabel = (input: {
  readonly id: CodexWindowId;
  readonly windowDurationMins: unknown;
}): string => {
  const minutes = readFiniteNumber(input.windowDurationMins);
  if (minutes === undefined || minutes <= 0) {
    return CODEX_WINDOW_FALLBACK_LABELS[input.id];
  }

  const known = CODEX_WINDOW_DURATION_LABELS.get(minutes);
  if (known) return known;

  if (minutes < MINUTES_PER_HOUR) return `${Math.round(minutes)}m`;
  if (minutes < MINUTES_PER_DAY) return `${Math.round(minutes / MINUTES_PER_HOUR)}h`;
  return `${Math.round(minutes / MINUTES_PER_DAY)}d`;
};

const normalizeCodexWindow = (input: {
  readonly id: CodexWindowId;
  readonly raw: unknown;
}): ServerProviderUsageWindow | undefined => {
  const window = readRecord(input.raw);
  if (!window) return undefined;

  return makeUsageWindow({
    id: input.id,
    label: codexWindowLabel({ id: input.id, windowDurationMins: window["windowDurationMins"] }),
    percent: clampUsagePercent(window["usedPercent"]),
    resetsAt: epochToIsoDateTime(window["resetsAt"]),
  });
};

/**
 * Unwrap `{ rateLimits: … }` envelopes down to the `RateLimitSnapshot`.
 *
 * Stops as soon as the record stops nesting, so all three payload shapes
 * converge on the same object.
 */
const unwrapRateLimitSnapshot = (raw: unknown): Record<string, unknown> | undefined => {
  let current = readRecord(raw);
  // Two levels max today (notification forwarded whole inside the event
  // payload); the guard is a bound, not a shape assertion.
  for (let depth = 0; depth < 2; depth += 1) {
    if (!current) return undefined;
    const nested = readRecord(current["rateLimits"]);
    if (!nested) return current;
    current = nested;
  }
  return current;
};

/**
 * Normalize any Codex rate-limit payload into `ServerProviderUsage`.
 *
 * Returns `undefined` when the payload carries no snapshot at all, so callers
 * leave the previous usage untouched.
 *
 * Note this never returns `available: false`: Codex reports rate limits only
 * for ChatGPT-authed sessions, and an API-key session simply never emits a
 * snapshot — there is no negative signal to translate, unlike Claude's
 * explicit `rate_limits_available: false`.
 */
export const normalizeCodexUsage = (input: {
  readonly raw: unknown;
  readonly capturedAt: string;
  readonly source: ServerProviderUsage["source"];
}): ServerProviderUsage | undefined => {
  const snapshot = unwrapRateLimitSnapshot(input.raw);
  if (!snapshot) return undefined;

  const windows: ServerProviderUsageWindow[] = [];
  for (const id of CODEX_WINDOW_IDS) {
    const window = normalizeCodexWindow({ id, raw: snapshot[id] });
    if (window) windows.push(window);
  }

  const planType = readCodexPlanType(snapshot["planType"]);
  const planLabel = planType ? (codexPlanTypeLabel(planType) ?? null) : null;

  // Nothing actionable — don't publish an empty usage that would render as
  // "0 windows" and stamp a fresh `capturedAt` over real data.
  if (windows.length === 0 && planLabel === null) return undefined;

  return {
    available: true,
    planLabel,
    windows,
    capturedAt: input.capturedAt,
    source: input.source,
  };
};
