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
 * `@anthropic-ai/claude-agent-sdk@0.3.170`'s `sdk.d.ts`, and its `kind` values
 * (`session`, `weekly_all`, `weekly_scoped`) do not map onto `rateLimitType`
 * without guessing. So the declared named windows stay the source of truth for
 * ids and percentages, and `limits[]` is read opportunistically for the one
 * thing the named windows lack: `severity`. If the array disappears or drifts,
 * windows simply lose their severity hint — nothing else breaks.
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

/** Ordered so `windows[]` renders 5h → weekly → per-model consistently. */
const CLAUDE_PROBE_WINDOW_IDS = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_oauth_apps",
] as const satisfies ReadonlyArray<ClaudeWindowId>;

const claudeWindowLabel = (id: string): string =>
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
 * Read `rate_limits.limits[]` for severity keyed by our canonical window id.
 *
 * Undeclared, best-effort: anything unrecognized is skipped silently.
 */
const readLimitSeverities = (
  rateLimits: Record<string, unknown>,
): ReadonlyMap<string, NonNullable<ServerProviderUsageWindow["severity"]>> => {
  const severities = new Map<string, NonNullable<ServerProviderUsageWindow["severity"]>>();
  const limits = rateLimits["limits"];
  if (!Array.isArray(limits)) return severities;

  for (const entry of limits) {
    const limit = readRecord(entry);
    if (!limit) continue;
    if (limit["is_active"] === false) continue;

    const severity = readSeverity(limit["severity"]);
    if (!severity) continue;

    const id = claudeWindowIdFromLimit(limit);
    if (id) severities.set(id, severity);
  }
  return severities;
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
  readonly severity: ServerProviderUsageWindow["severity"];
}): ServerProviderUsageWindow | undefined => {
  const window = readRecord(input.raw);
  if (!window) return undefined;

  return makeUsageWindow({
    id: input.id,
    label: claudeWindowLabel(input.id),
    percent: clampUsagePercent(window["utilization"]),
    resetsAt: isoStringToIsoDateTime(window["resets_at"]),
    severity: input.severity,
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

  const severities = readLimitSeverities(rateLimits);
  const windows: ServerProviderUsageWindow[] = [];
  for (const id of CLAUDE_PROBE_WINDOW_IDS) {
    const window = normalizeNamedWindow({
      id,
      raw: rateLimits[id],
      severity: severities.get(id),
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

/** `SDKRateLimitEvent` → usage carrying the single pushed window. */
const normalizeClaudeUsageEvent = (input: {
  readonly rateLimitInfo: Record<string, unknown>;
  readonly capturedAt: string;
}): ServerProviderUsage | undefined => {
  const id = readNonEmptyString(input.rateLimitInfo["rateLimitType"]);
  if (!id) return undefined;

  const window = makeUsageWindow({
    id,
    label: claudeWindowLabel(id),
    percent: clampUsagePercent(input.rateLimitInfo["utilization"]),
    // Events carry epoch seconds here, unlike the probe's ISO `resets_at`.
    resetsAt: epochToIsoDateTime(input.rateLimitInfo["resetsAt"]),
    severity: readSeverity(input.rateLimitInfo["status"]),
  });

  return {
    available: true,
    // The event says nothing about the plan; `mergeProviderUsage` restores the
    // probed `planLabel` rather than letting this null blank it.
    planLabel: null,
    windows: [window],
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
