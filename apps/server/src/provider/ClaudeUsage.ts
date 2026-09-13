/**
 * ClaudeUsage — normalize Claude Agent SDK plan usage into `ServerProviderUsage`.
 *
 * Two genuinely different payloads land here, which is why
 * `AccountRateLimitsUpdatedPayload.rateLimits` stays `Schema.Unknown` in the
 * contract and normalization happens at this edge instead:
 *
 *  1. **Probe** — `SDKControlGetUsageResponse`, from the experimental
 *     `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` query
 *     method. Carries `subscription_type`, `rate_limits_available`, and the
 *     full set of named windows. This is the cold-start baseline.
 *  2. **Event** — `SDKRateLimitEvent`, pushed as `rate_limit_event` on the
 *     message stream. Carries `rate_limit_info`, which describes exactly
 *     *one* window (`rateLimitType`) and nothing about the rest — hence the
 *     merge in `mergeProviderUsage` rather than a replace.
 *
 * ## Window ids
 *
 * Ids are the SDK's own `rateLimitType` values (`five_hour`, `seven_day`,
 * `seven_day_opus`, …). That choice is load-bearing: it is the only id space
 * both payloads above can agree on, and the merge key has to line up across
 * them or an event would append a duplicate window instead of updating the
 * probed one.
 *
 * ## `rate_limits.limits[]`
 *
 * The live API also returns a pre-normalized `limits[]` array
 * (kind/group/percent/severity/scope). It is **not** declared in
 * `@anthropic-ai/claude-agent-sdk@0.3.170`'s `sdk.d.ts`, so the declared named
 * windows remain the source of truth. The stable standard kinds (`session` and
 * `weekly_all`) are nevertheless useful fallbacks when a named window's
 * `utilization` is null, as happens for some accounts. Unknown kinds are
 * ignored. If the array disappears or drifts, the named-window path continues
 * to work unchanged.
 *
 * @module provider/ClaudeUsage
 */
import type { ServerProviderUsage, ServerProviderUsageWindow } from "@t3tools/contracts";

import {
  clampUsagePercent,
  epochToIsoDateTime,
  isoStringToIsoDateTime,
  makeUsageWindow,
  readNonEmptyString,
  readRecord,
} from "./providerUsage.ts";

/**
 * Named windows from `SDKControlGetUsageResponse.rate_limits`, in the order
 * the UI should show them. Ids match `SDKRateLimitInfo.rateLimitType` so probe
 * and event updates merge onto the same window.
 */
const CLAUDE_WINDOW_LABELS = {
  five_hour: "Session",
  seven_day: "Weekly",
  seven_day_opus: "Weekly (Opus)",
  seven_day_sonnet: "Weekly (Sonnet)",
  seven_day_oauth_apps: "Weekly (Apps)",
  overage: "Extra usage",
} as const satisfies Record<string, string>;

type ClaudeWindowId = keyof typeof CLAUDE_WINDOW_LABELS;

/**
 * How wide each named window is, in minutes. The SDK reports only `resets_at`,
 * never the window's start, so these constants are what let the UI place a
 * window's elapsed fraction against its used fraction. They are the durations
 * the ids are named for — `five_hour` is five hours by definition — so they
 * cannot drift without the id changing too. `overage` has no fixed span and is
 * deliberately absent.
 */
const CLAUDE_WINDOW_MINUTES = {
  five_hour: 5 * 60,
  seven_day: 7 * 24 * 60,
  seven_day_opus: 7 * 24 * 60,
  seven_day_sonnet: 7 * 24 * 60,
  seven_day_oauth_apps: 7 * 24 * 60,
} as const satisfies Partial<Record<ClaudeWindowId, number>>;

const claudeWindowMinutes = (id: string): number | undefined =>
  CLAUDE_WINDOW_MINUTES[id as keyof typeof CLAUDE_WINDOW_MINUTES];

/** Ordered so `windows[]` renders 5h → weekly → per-model consistently. */
const CLAUDE_PROBE_WINDOW_IDS = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_oauth_apps",
] as const satisfies ReadonlyArray<ClaudeWindowId>;

/** Name of the Agent SDK's unstable plan-usage control method. */
export const CLAUDE_USAGE_METHOD =
  "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET" as const;

export const claudeWindowLabel = (id: string): string =>
  CLAUDE_WINDOW_LABELS[id as ClaudeWindowId] ?? "Plan limit";

/**
 * `SDKRateLimitInfo.status` and `limits[].severity` both describe how close a
 * window is to rejection; collapse them onto the contract's severity scale.
 */
const readSeverity = (value: unknown): ServerProviderUsageWindow["severity"] => {
  switch (readNonEmptyString(value)) {
    case "allowed":
    case "normal":
    case "ok":
      return "normal";
    case "allowed_warning":
    case "warning":
      return "warning";
    case "rejected":
    case "critical":
      return "critical";
    default:
      return undefined;
  }
};

/**
 * Read standard `rate_limits.limits[]` values keyed by our canonical window id.
 *
 * Undeclared, best-effort: anything unrecognized is skipped silently.
 */
interface ClaudeLimitFallback {
  readonly percent: number | null;
  readonly resetsAt: string | null;
  readonly severity: ServerProviderUsageWindow["severity"];
}

const readLimitFallbacks = (
  rateLimits: Record<string, unknown>,
): ReadonlyMap<string, ClaudeLimitFallback> => {
  const fallbacks = new Map<string, ClaudeLimitFallback>();
  const limits = rateLimits["limits"];
  if (!Array.isArray(limits)) return fallbacks;

  for (const entry of limits) {
    const limit = readRecord(entry);
    if (!limit) continue;
    if (limit["is_active"] === false) continue;

    const id = claudeWindowIdFromLimit(limit);
    if (!id) continue;

    fallbacks.set(id, {
      percent: clampUsagePercent(limit["percent"]),
      resetsAt: isoStringToIsoDateTime(limit["resets_at"]) ?? epochToIsoDateTime(limit["resetsAt"]),
      severity: readSeverity(limit["severity"]),
    });
  }
  return fallbacks;
};

/**
 * Map a `limits[]` entry onto a named-window id.
 *
 * `weekly_scoped` entries identify their model through
 * `scope.model.display_name` ("Opus", "Sonnet"), which is what distinguishes
 * `seven_day_opus` from `seven_day_sonnet`.
 */
const claudeWindowIdFromLimit = (limit: Record<string, unknown>): ClaudeWindowId | undefined => {
  const kind = readNonEmptyString(limit["kind"]);
  if (kind === "session") return "five_hour";
  if (kind === "weekly_all") return "seven_day";
  if (kind !== "weekly_scoped") return undefined;

  const displayName =
    readNonEmptyString(readRecord(readRecord(limit["scope"])?.["model"])?.["display_name"]) ??
    readNonEmptyString(limit["group"]);
  if (!displayName) return undefined;

  const lowered = displayName.toLowerCase();
  if (lowered.includes("opus")) return "seven_day_opus";
  if (lowered.includes("sonnet")) return "seven_day_sonnet";
  return undefined;
};

/** `{ utilization, resets_at }` — the shape every named window shares. */
const normalizeNamedWindow = (input: {
  readonly id: ClaudeWindowId;
  readonly raw: unknown;
  readonly fallback: ClaudeLimitFallback | undefined;
}): ServerProviderUsageWindow | undefined => {
  const window = readRecord(input.raw);
  if (!window && !input.fallback) return undefined;

  return makeUsageWindow({
    id: input.id,
    label: claudeWindowLabel(input.id),
    windowMinutes: claudeWindowMinutes(input.id),
    percent:
      (window ? clampUsagePercent(window["utilization"]) : null) ?? input.fallback?.percent ?? null,
    resetsAt:
      (window ? isoStringToIsoDateTime(window["resets_at"]) : null) ??
      input.fallback?.resetsAt ??
      null,
    severity: input.fallback?.severity,
  });
};

/** `SDKControlGetUsageResponse` → usage. */
const normalizeClaudeUsageProbe = (input: {
  readonly response: Record<string, unknown>;
  readonly capturedAt: string;
}): ServerProviderUsage => {
  const planLabel = readNonEmptyString(input.response["subscription_type"]) ?? null;
  const rateLimits = readRecord(input.response["rate_limits"]);

  // `rate_limits_available: false` is an explicit "plan limits do not apply"
  // (API key / Bedrock / Vertex), which is a real answer — not missing data.
  if (input.response["rate_limits_available"] === false || rateLimits === undefined) {
    return {
      available: false,
      planLabel,
      windows: [],
      capturedAt: input.capturedAt,
      source: "probe",
      message: "Plan rate limits do not apply to this Claude session.",
    };
  }

  const fallbacks = readLimitFallbacks(rateLimits);
  const windows: ServerProviderUsageWindow[] = [];
  for (const id of CLAUDE_PROBE_WINDOW_IDS) {
    const window = normalizeNamedWindow({
      id,
      raw: rateLimits[id],
      fallback: fallbacks.get(id),
    });
    if (window) windows.push(window);
  }

  return {
    available: true,
    planLabel,
    windows,
    capturedAt: input.capturedAt,
    source: "probe",
  };
};

/**
 * Rescale a pushed `utilization` onto the contract's 0-100 percentage.
 *
 * The probe and the push disagree, and the SDK only documents one of them.
 * `SDKControlGetUsageResponse` declares its windows as "Percentage of the
 * window used, 0-100"; `SDKRateLimitInfo.utilization` is declared as a bare
 * number and ships a **fraction** — every push observed carries values like
 * `0.31` for a window the probe reports as `31`. Read as a percentage that is
 * a hundredfold under-report, which is worse than no reading at all: it says a
 * nearly spent window is untouched.
 *
 * Values above 1 are passed through unscaled, so if the push is ever brought
 * into line with the probe this keeps working. Exactly `1` is read as a spent
 * window rather than one percent — of the two readings, over-reporting a limit
 * is the one that fails safely.
 */
const scaleEventUtilization = (value: unknown): number | null => {
  const percent = clampUsagePercent(value);
  if (percent === null) return null;
  return percent <= 1 ? percent * 100 : percent;
};

/**
 * Every window a push knows about, from its undeclared `unifiedWindows`.
 *
 * The declared part of the payload describes one window — whichever tripped
 * the push — and its `utilization` is routinely absent: every observed
 * `five_hour` push omits it. `unifiedWindows` carries the numbers for all of
 * them regardless, which is what keeps the session window from going blank
 * between probes. Undeclared, so read defensively; if it disappears the named
 * window below still updates.
 */
const readUnifiedWindows = (
  rateLimitInfo: Record<string, unknown>,
): ReadonlyArray<ServerProviderUsageWindow> => {
  const unified = readRecord(rateLimitInfo["unifiedWindows"]);
  if (!unified) return [];

  const windows: Array<ServerProviderUsageWindow> = [];
  for (const [id, raw] of Object.entries(unified)) {
    const window = readRecord(raw);
    if (!window) continue;
    const percent = scaleEventUtilization(window["utilization"]);
    const resetsAt = epochToIsoDateTime(window["resetsAt"]);
    if (percent === null && resetsAt === null) continue;
    windows.push(
      makeUsageWindow({
        id,
        label: claudeWindowLabel(id),
        windowMinutes: claudeWindowMinutes(id),
        percent,
        resetsAt,
      }),
    );
  }
  return windows;
};

/** `SDKRateLimitEvent` -> usage carrying every window the push describes. */
const normalizeClaudeUsageEvent = (input: {
  readonly rateLimitInfo: Record<string, unknown>;
  readonly capturedAt: string;
}): ServerProviderUsage | undefined => {
  const windowsById = new Map<string, ServerProviderUsageWindow>();
  for (const window of readUnifiedWindows(input.rateLimitInfo)) {
    windowsById.set(window.id, window);
  }

  // The named window is the one the push is actually about, so its severity
  // and reset time win over the unified copy. Its percentage is often absent,
  // in which case the unified value it arrived alongside stands.
  const id = readNonEmptyString(input.rateLimitInfo["rateLimitType"]);
  if (id) {
    const unified = windowsById.get(id);
    const percent = scaleEventUtilization(input.rateLimitInfo["utilization"]);
    windowsById.set(
      id,
      makeUsageWindow({
        id,
        label: claudeWindowLabel(id),
        windowMinutes: claudeWindowMinutes(id),
        percent: percent ?? unified?.percent ?? null,
        // Events carry epoch seconds here, unlike the probe's ISO `resets_at`.
        resetsAt: epochToIsoDateTime(input.rateLimitInfo["resetsAt"]) ?? unified?.resetsAt ?? null,
        severity: readSeverity(input.rateLimitInfo["status"]),
      }),
    );
  }

  if (windowsById.size === 0) return undefined;

  return {
    available: true,
    // The event says nothing about the plan; `mergeProviderUsage` restores the
    // probed `planLabel` rather than letting this null blank it.
    planLabel: null,
    windows: [...windowsById.values()],
    capturedAt: input.capturedAt,
    source: "event",
  };
};

/**
 * Normalize any Claude usage payload into `ServerProviderUsage`.
 *
 * Returns `undefined` when the payload carries nothing usable, so callers can
 * leave the previous usage untouched instead of publishing an empty snapshot.
 */
export const normalizeClaudeUsage = (input: {
  readonly raw: unknown;
  readonly capturedAt: string;
}): ServerProviderUsage | undefined => {
  const record = readRecord(input.raw);
  if (!record) return undefined;

  // `rate_limit_event` push — the adapter forwards the whole SDK message.
  const rateLimitInfo = readRecord(record["rate_limit_info"]);
  if (rateLimitInfo) {
    return normalizeClaudeUsageEvent({ rateLimitInfo, capturedAt: input.capturedAt });
  }

  // Probe response — identified by the availability flag, the one field the
  // usage API always sets.
  if (typeof record["rate_limits_available"] === "boolean") {
    return normalizeClaudeUsageProbe({ response: record, capturedAt: input.capturedAt });
  }

  return undefined;
};
