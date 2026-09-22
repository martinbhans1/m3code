import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageSeverity,
} from "@t3tools/contracts";

/**
 * Per-window alert bookkeeping.
 *
 * `notifiedAt` maps a threshold to the moment it was last reported, which is
 * what makes both dedupe ("already told you") and the optional repeat cadence
 * ("tell me again every N minutes") a single lookup.
 */
export interface ProviderUsageAlertState {
  readonly percent: number;
  readonly notifiedAt: ReadonlyMap<number, number>;
}

export interface ProviderUsageAlert {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ServerProvider["driver"];
  readonly windowId: string;
  readonly windowLabel: string;
  readonly percent: number;
  readonly threshold: number;
  readonly resetsAt: string | null;
  readonly severity: ServerProviderUsageSeverity | undefined;
}

export interface ProviderUsageAlertEvaluation {
  readonly alerts: ReadonlyArray<ProviderUsageAlert>;
  readonly state: ReadonlyMap<string, ProviderUsageAlertState>;
}

/**
 * How far usage has to fall in one step to count as "the window rolled over"
 * rather than ordinary noise. A reset that is immediately followed by heavy use
 * can land above a threshold before we ever observe a low percentage, so the
 * drop itself — not the reported reset timestamp — is the re-arm signal.
 *
 * Reset timestamps deliberately play no part in this. Providers re-report them
 * with jitter (and rolling windows genuinely drift), so keying dedupe on the
 * timestamp made every poll look like a fresh cycle and re-fired the same
 * alert for as long as usage stayed high.
 */
const RESET_DROP_POINTS = 10;

const stateKey = (instanceId: ProviderInstanceId, windowId: string) => `${instanceId}:${windowId}`;

export function normalizeProviderUsageAlertThresholds(
  values: ReadonlyArray<number>,
): ReadonlyArray<number> {
  return [
    ...new Set(values.filter((value) => Number.isInteger(value) && value >= 1 && value <= 100)),
  ].sort((a, b) => a - b);
}

export function parseProviderUsageAlertThresholds(value: string): ReadonlyArray<number> {
  return normalizeProviderUsageAlertThresholds(
    value
      .split(/[\s,;]+/u)
      .filter(Boolean)
      .map(Number),
  );
}

/**
 * Find thresholds that deserve a notification right now, and carry dedupe state
 * into the next provider snapshot.
 *
 * A threshold fires when usage first crosses it, and then stays silent until
 * either usage falls back below it (or the window resets) or `repeatMinutes`
 * has elapsed. When one update leaps across several thresholds, only the
 * highest is surfaced and every lower one is marked reported to avoid a storm.
 */
export function evaluateProviderUsageAlerts(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly thresholds: ReadonlyArray<number>;
  readonly previous: ReadonlyMap<string, ProviderUsageAlertState>;
  /** `0` (the default) never repeats an alert while usage stays above it. */
  readonly repeatMinutes?: number;
  readonly now?: number;
}): ProviderUsageAlertEvaluation {
  const thresholds = normalizeProviderUsageAlertThresholds(input.thresholds);
  const now = input.now ?? Date.now();
  const repeatMs =
    input.repeatMinutes !== undefined && input.repeatMinutes > 0
      ? input.repeatMinutes * 60_000
      : null;
  // Preserve entries that temporarily disappear while provider status is
  // refreshing. Dropping them would make the same high usage look like a new
  // first observation and emit a duplicate alert when the snapshot returns.
  const next = new Map(input.previous);
  const alerts: ProviderUsageAlert[] = [];

  for (const provider of input.providers) {
    if (!provider.usage?.available) continue;

    for (const window of provider.usage.windows) {
      const percent = window.percent;
      if (percent === null) continue;

      const key = stateKey(provider.instanceId, window.id);
      const previous = input.previous.get(key);
      const rolledOver = previous !== undefined && percent <= previous.percent - RESET_DROP_POINTS;
      const notifiedAt = new Map(rolledOver ? [] : (previous?.notifiedAt ?? []));

      const fired: number[] = [];
      for (const threshold of thresholds) {
        if (percent < threshold) {
          // Below the line again — re-arm so the next crossing is reported.
          notifiedAt.delete(threshold);
          continue;
        }
        const last = notifiedAt.get(threshold);
        const due = last === undefined || (repeatMs !== null && now - last >= repeatMs);
        if (!due) continue;
        notifiedAt.set(threshold, now);
        fired.push(threshold);
      }

      const highestFired = fired.at(-1);
      if (highestFired !== undefined) {
        alerts.push({
          instanceId: provider.instanceId,
          driver: provider.driver,
          windowId: window.id,
          windowLabel: window.label,
          percent,
          threshold: highestFired,
          resetsAt: window.resetsAt,
          severity: window.severity,
        });
      }

      next.set(key, { percent, notifiedAt });
    }
  }

  return { alerts, state: next };
}

// ── Persistence ───────────────────────────────────────────────
//
// Kept in `localStorage` so a reload — which the desktop app does on every
// update and every dev rebuild — does not re-announce usage the user has
// already been told about.

const STORAGE_KEY = "t3:provider-usage-alerts";

interface StoredWindowState {
  readonly percent: number;
  readonly notifiedAt: ReadonlyArray<readonly [number, number]>;
}

export function serializeProviderUsageAlertState(
  state: ReadonlyMap<string, ProviderUsageAlertState>,
): string {
  const payload: Record<string, StoredWindowState> = {};
  for (const [key, value] of state) {
    payload[key] = { percent: value.percent, notifiedAt: [...value.notifiedAt] };
  }
  return JSON.stringify(payload);
}

/** Tolerant by design: any malformed entry is dropped, never thrown. */
export function deserializeProviderUsageAlertState(
  raw: string | null,
): ReadonlyMap<string, ProviderUsageAlertState> {
  const state = new Map<string, ProviderUsageAlertState>();
  if (!raw) return state;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return state;
  }
  if (typeof parsed !== "object" || parsed === null) return state;

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Partial<StoredWindowState>;
    if (typeof entry.percent !== "number" || !Array.isArray(entry.notifiedAt)) continue;
    const notifiedAt = new Map<number, number>();
    for (const pair of entry.notifiedAt) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [threshold, at] = pair;
      if (typeof threshold !== "number" || typeof at !== "number") continue;
      notifiedAt.set(threshold, at);
    }
    state.set(key, { percent: entry.percent, notifiedAt });
  }
  return state;
}

export function loadProviderUsageAlertState(): ReadonlyMap<string, ProviderUsageAlertState> {
  try {
    return deserializeProviderUsageAlertState(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return new Map();
  }
}

export function saveProviderUsageAlertState(
  state: ReadonlyMap<string, ProviderUsageAlertState>,
): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeProviderUsageAlertState(state));
  } catch {
    // Private mode / quota — dedupe simply falls back to in-memory only.
  }
}
