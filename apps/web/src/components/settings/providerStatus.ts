import type {
  ServerProvider,
  ServerProviderUsageSeverity,
  ServerProviderUsageWindow,
  ServerProviderVersionAdvisory,
} from "@t3tools/contracts";

import { formatPercentLabel } from "~/lib/utils";

/**
 * Visual treatment for each server-reported provider status. Centralized so
 * the default-driver card and per-instance cards share the same language.
 */
export const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-amber-400",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

/**
 * Derive the headline + detail copy shown under a provider's name in the
 * settings page. Prefers `provider.message` for server-supplied detail and
 * falls back to generic phrasing when the server has not yet reported any
 * state — which happens before the first probe or when an instance names a
 * driver this build does not ship.
 */
export function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "Disabled",
      detail:
        provider.message ?? "This provider is installed but disabled for new sessions in M3 Code.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "CLI not detected on PATH.",
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authenticated · ${authLabel}` : "Authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: "Not authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  return {
    headline: "Available",
    detail: provider.message ?? "Installed and ready, but authentication could not be verified.",
  };
}

/**
 * Normalize a version string for display. Adds the `v` prefix when the
 * driver reported a bare version (e.g. `1.2.3`) so cards render
 * consistently regardless of driver.
 */
export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
): {
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
} | null {
  if (!advisory || advisory.status === "current" || advisory.status === "unknown") {
    return null;
  }

  const label = "Update available";
  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);

  return {
    detail:
      advisory.message ??
      (versionLabel
        ? `${label}: install ${versionLabel}.`
        : `${label}: install the latest provider version.`),
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
  };
}

// --------------------------------------------------------------------------
// Plan usage
// --------------------------------------------------------------------------

/**
 * Utilization cutoffs applied when a provider reports no `severity` of its
 * own — Codex never does, and Claude only starts once it is already warning.
 *
 * Deliberately inclusive (`>=`): a window reported at exactly 90% is at the
 * cutoff, not below it. This is a hair stricter than the context layer in
 * `ComposerUsageMeter`, which uses `> 90`: context is a soft budget that
 * compaction reclaims, while a plan window is a hard limit that stops the
 * session.
 */
const USAGE_WARNING_PERCENT = 75;
const USAGE_CRITICAL_PERCENT = 90;

/**
 * How old a capture must be before the panels admit to it. Plan usage arrives
 * on rate-limit events, so an idle session legitimately goes minutes without
 * an update; calling that "stale" would train users to ignore the label.
 */
const USAGE_STALE_AFTER_MS = 5 * 60 * 1000;

const USAGE_SEVERITY_RANK: Record<ServerProviderUsageSeverity, number> = {
  normal: 0,
  warning: 1,
  critical: 2,
};

/**
 * Whether the current burn rate lands inside the window or blows through it.
 *
 * Three tiers rather than two because "will finish at 96%" and "will run out
 * with two hours to spare" call for different reactions, and a single
 * over/under flag collapses them.
 */
export type ProviderUsagePaceStatus = "comfortable" | "tight" | "exhausting";

/**
 * Burn-rate projection for one window: where the clock is, versus where the
 * usage is.
 *
 * Providers report only `resetsAt`, never a window's start, so this exists
 * only for windows that also declare `windowMinutes` — the two together give
 * the elapsed fraction. Extrapolation is deliberately naive (assume the
 * average rate so far continues), which is the only honest thing to do with a
 * single utilization sample and is what the user is estimating in their head
 * anyway.
 */
export interface ProviderUsagePacePresentation {
  /** How far through the window the clock is, `0`–`100`. */
  readonly elapsedPercent: number;
  /** Utilization at reset if the average rate so far holds. Uncapped view is clamped to 999. */
  readonly projectedPercent: number;
  readonly status: ProviderUsagePaceStatus;
  /** One-line verdict, e.g. `On pace for ~68% by reset`. */
  readonly label: string;
}

/** One plan window, formatted for display. */
export interface ProviderUsageWindowPresentation {
  readonly id: string;
  readonly label: string;
  /** Raw `0`–`100`, retained for meters; `null` when utilization is unknown. */
  readonly percent: number | null;
  readonly percentLabel: string | null;
  readonly resetLabel: string | null;
  readonly severity: ServerProviderUsageSeverity;
  /** `null` when the window is too young, or lacks the data, to project. */
  readonly pace: ProviderUsagePacePresentation | null;
}

/**
 * Presentation view of `ServerProvider.usage`.
 *
 * The three kinds are deliberately distinct because they are three different
 * facts, and collapsing any two of them produces a lie:
 * - `unknown` — no usage observed. This is the steady state for the first
 *   seconds after boot (usage is stripped from the on-disk cache and only
 *   repopulated by a live probe) *and* the permanent state for drivers with
 *   no plan limits to report. It is not an error and must not render as one.
 * - `unavailable` — the provider told us plan limits do not apply at all
 *   (API key, Bedrock, Vertex). Also not an error.
 * - `measured` — real windows to render.
 */
export type ProviderUsageSummary =
  | { readonly kind: "unknown" }
  | { readonly kind: "unavailable"; readonly detail: string }
  | {
      readonly kind: "measured";
      readonly planLabel: string | null;
      readonly windows: ReadonlyArray<ProviderUsageWindowPresentation>;
      /**
       * The binding constraint: the most severe window, breaking ties on the
       * highest utilization. A single-dial meter must take BOTH its length and
       * its color from this one window — deriving colour from an aggregate
       * severity and length from a different window would paint a dial that
       * describes no real window at all.
       *
       * `null` when no window reported a utilization, which is distinct from
       * 0%: callers must not render it as an empty dial.
       */
      readonly headline: ProviderUsageWindowPresentation | null;
      /** Non-null only once the capture is old enough to be worth flagging. */
      readonly staleLabel: string | null;
    };

function parseTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Compact duration: `45m`, `2h 14m`, `3d 4h`. Always rounds *down* to whole
 * minutes so a countdown never promises a reset that has not happened yet.
 */
function formatCompactDuration(durationMs: number): string {
  const totalMinutes = Math.floor(Math.max(0, durationMs) / 60_000);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `${totalHours}h` : `${totalHours}h ${minutes}m`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/**
 * Countdown to a window reset, e.g. `Resets in 2h 14m`.
 *
 * A reset time routinely drifts into the past between provider pushes, so
 * anything under a minute out (including the past) collapses to "Resets
 * shortly" rather than rendering a negative countdown.
 */
export function formatProviderUsageResetLabel(resetsAt: string | null, now: number): string | null {
  if (resetsAt === null) {
    return null;
  }
  const resetsAtMs = parseTimestamp(resetsAt);
  if (resetsAtMs === null) {
    return null;
  }
  const remainingMs = resetsAtMs - now;
  if (remainingMs < 60_000) {
    return "Resets shortly";
  }
  return `Resets in ${formatCompactDuration(remainingMs)}`;
}

/**
 * Staleness note for a capture, e.g. `Updated 12m ago`. `null` while the
 * capture is recent enough that its age is not worth the user's attention.
 */
export function formatProviderUsageStaleLabel(capturedAt: string, now: number): string | null {
  const capturedAtMs = parseTimestamp(capturedAt);
  if (capturedAtMs === null) {
    return null;
  }
  const ageMs = now - capturedAtMs;
  if (ageMs < USAGE_STALE_AFTER_MS) {
    return null;
  }
  return `Updated ${formatCompactDuration(ageMs)} ago`;
}

/**
 * Fraction of a window that must have elapsed before a projection is worth
 * showing. Two minutes into a five-hour window, one burst of usage
 * extrapolates to "you will run out ten times over" — technically the average
 * rate, but useless as advice. Waiting until the window is 8% old keeps the
 * first projection from being nonsense.
 */
const PACE_MIN_ELAPSED_FRACTION = 0.08;

/** Projections above this are capped: the exact number stops meaning anything. */
const PACE_MAX_PROJECTED_PERCENT = 999;

/** Projected utilization at reset that counts as cutting it close. */
const PACE_TIGHT_PROJECTED_PERCENT = 85;

/**
 * Project a window's finishing utilization from the rate so far.
 *
 * Returns `null` whenever the projection would be guesswork rather than
 * information: no utilization reported, no reset time, no declared window
 * width, or too little of the window elapsed to divide by.
 */
export function getProviderUsagePace(
  window: ServerProviderUsageWindow,
  now: number,
): ProviderUsagePacePresentation | null {
  const percent = window.percent;
  const windowMinutes = window.windowMinutes;
  if (percent === null || windowMinutes === undefined || window.resetsAt === null) {
    return null;
  }

  const resetsAtMs = parseTimestamp(window.resetsAt);
  if (resetsAtMs === null) {
    return null;
  }

  const windowMs = windowMinutes * 60_000;
  const elapsedMs = Math.min(windowMs, windowMs - (resetsAtMs - now));
  const elapsedFraction = elapsedMs / windowMs;
  if (!Number.isFinite(elapsedFraction) || elapsedFraction < PACE_MIN_ELAPSED_FRACTION) {
    return null;
  }

  const projectedPercent = Math.min(PACE_MAX_PROJECTED_PERCENT, percent / elapsedFraction);
  const elapsedPercent = Math.min(100, Math.max(0, elapsedFraction * 100));

  // Already spent: the projection is moot, the window is the ceiling.
  if (percent >= 100) {
    return {
      elapsedPercent,
      projectedPercent,
      status: "exhausting",
      label: "Limit reached — waiting on the reset",
    };
  }

  if (projectedPercent >= 100) {
    // Time from now until utilization would hit 100% at the observed rate.
    const ratePerMs = percent / elapsedMs;
    const msToLimit = ratePerMs > 0 ? (100 - percent) / ratePerMs : Number.POSITIVE_INFINITY;
    const label = Number.isFinite(msToLimit)
      ? msToLimit < 60_000
        ? "At this rate, you run out within the minute"
        : `At this rate, you run out in ${formatCompactDuration(msToLimit)}`
      : "At this rate, you run out before the reset";
    return { elapsedPercent, projectedPercent, status: "exhausting", label };
  }

  return {
    elapsedPercent,
    projectedPercent,
    status: projectedPercent >= PACE_TIGHT_PROJECTED_PERCENT ? "tight" : "comfortable",
    label: `On pace for ~${Math.round(projectedPercent)}% by reset`,
  };
}

function severityFromPercent(percent: number | null): ServerProviderUsageSeverity {
  if (percent === null) {
    return "normal";
  }
  if (percent >= USAGE_CRITICAL_PERCENT) {
    return "critical";
  }
  if (percent >= USAGE_WARNING_PERCENT) {
    return "warning";
  }
  return "normal";
}

function presentUsageWindow(
  window: ServerProviderUsageWindow,
  now: number,
): ProviderUsageWindowPresentation {
  return {
    id: window.id,
    label: window.label,
    percent: window.percent,
    percentLabel: formatPercentLabel(window.percent),
    resetLabel: formatProviderUsageResetLabel(window.resetsAt, now),
    // Prefer the provider's own severity: it knows plan-specific cutoffs we
    // cannot infer from a percentage alone.
    severity: window.severity ?? severityFromPercent(window.percent),
    pace: getProviderUsagePace(window, now),
  };
}

/**
 * Derive the plan-usage presentation for a provider snapshot. Pure: `now` is
 * injected so relative labels are testable.
 *
 * Sibling of `getProviderSummary` — same contract, same file, so the status
 * card and the usage meters cannot drift apart on provider phrasing.
 */
export function getProviderUsageSummary(
  provider: ServerProvider | undefined,
  now: number,
): ProviderUsageSummary {
  const usage = provider?.usage;
  if (!usage) {
    return { kind: "unknown" };
  }
  if (!usage.available) {
    return {
      kind: "unavailable",
      detail: usage.message ?? "Plan limits don't apply to this account.",
    };
  }

  const windows = usage.windows.map((window) => presentUsageWindow(window, now));

  let headline: ProviderUsageWindowPresentation | null = null;
  for (const window of windows) {
    // Windows with unknown utilization can never be the headline: a dial has
    // no honest length to draw for them.
    if (window.percent === null) {
      continue;
    }
    if (headline === null || isMoreBinding(window, headline)) {
      headline = window;
    }
  }

  return {
    kind: "measured",
    planLabel: usage.planLabel,
    windows,
    headline,
    staleLabel: formatProviderUsageStaleLabel(usage.capturedAt, now),
  };
}

/**
 * Order two windows by how much they constrain the user: severity first,
 * then utilization. Severity leads because a provider that sets it knows
 * plan-specific cutoffs we cannot infer from a percentage — a window it calls
 * critical at 20% binds harder than one it leaves normal at 50%.
 *
 * Both arguments must have a non-null `percent`.
 */
function isMoreBinding(
  candidate: ProviderUsageWindowPresentation,
  incumbent: ProviderUsageWindowPresentation,
): boolean {
  const candidateRank = USAGE_SEVERITY_RANK[candidate.severity];
  const incumbentRank = USAGE_SEVERITY_RANK[incumbent.severity];
  if (candidateRank !== incumbentRank) {
    return candidateRank > incumbentRank;
  }
  return (candidate.percent ?? 0) > (incumbent.percent ?? 0);
}
