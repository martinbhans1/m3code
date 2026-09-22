import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deserializeProviderUsageAlertState,
  evaluateProviderUsageAlerts,
  normalizeProviderUsageAlertThresholds,
  parseProviderUsageAlertThresholds,
  serializeProviderUsageAlertState,
} from "./providerUsageAlerts.logic";

function provider(windows: ReadonlyArray<ServerProviderUsageWindow>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claude_work"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-08-21T09:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    usage: {
      available: true,
      planLabel: "max",
      windows: [...windows],
      capturedAt: "2026-08-21T09:00:00.000Z",
      source: "probe",
    },
  };
}

const session = (percent: number, resetsAt: string | null = null): ServerProviderUsageWindow => ({
  id: "five_hour",
  label: "Session",
  percent,
  resetsAt,
});

describe("provider usage alerts", () => {
  it("alerts once at each configured threshold", () => {
    const first = evaluateProviderUsageAlerts({
      providers: [provider([session(55)])],
      thresholds: [50, 80],
      previous: new Map(),
    });
    expect(first.alerts.map((alert) => alert.threshold)).toEqual([50]);

    const unchanged = evaluateProviderUsageAlerts({
      providers: [provider([session(61)])],
      thresholds: [50, 80],
      previous: first.state,
    });
    expect(unchanged.alerts).toEqual([]);

    const second = evaluateProviderUsageAlerts({
      providers: [provider([session(81)])],
      thresholds: [50, 80],
      previous: unchanged.state,
    });
    expect(second.alerts.map((alert) => alert.threshold)).toEqual([80]);
  });

  it("surfaces only the highest threshold after a large jump", () => {
    const result = evaluateProviderUsageAlerts({
      providers: [provider([session(100)])],
      thresholds: [50, 80],
      previous: new Map(),
    });

    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toMatchObject({ threshold: 80, percent: 100 });
  });

  it("stays quiet while usage hovers above a threshold it already reported", () => {
    let state = evaluateProviderUsageAlerts({
      providers: [provider([session(87, "2026-08-21T10:00:00.000Z")])],
      thresholds: [80],
      previous: new Map(),
    }).state;

    // Providers re-report `resetsAt` with jitter on every poll; that must not
    // look like a new cycle.
    for (const resetsAt of ["2026-08-21T10:02:00.000Z", "2026-08-21T09:58:00.000Z", null]) {
      const next = evaluateProviderUsageAlerts({
        providers: [provider([session(87, resetsAt)])],
        thresholds: [80],
        previous: state,
      });
      expect(next.alerts).toEqual([]);
      state = next.state;
    }
  });

  it("alerts again once the window resets and climbs back", () => {
    const first = evaluateProviderUsageAlerts({
      providers: [provider([session(87)])],
      thresholds: [80],
      previous: new Map(),
    });
    const reset = evaluateProviderUsageAlerts({
      providers: [provider([session(4)])],
      thresholds: [80],
      previous: first.state,
    });
    const climbed = evaluateProviderUsageAlerts({
      providers: [provider([session(82)])],
      thresholds: [80],
      previous: reset.state,
    });

    expect(reset.alerts).toEqual([]);
    expect(climbed.alerts.map((alert) => alert.threshold)).toEqual([80]);
  });

  it("re-arms on a sharp drop even when usage never dips below the threshold", () => {
    const first = evaluateProviderUsageAlerts({
      providers: [provider([session(95)])],
      thresholds: [80],
      previous: new Map(),
    });
    const rolledOver = evaluateProviderUsageAlerts({
      providers: [provider([session(83)])],
      thresholds: [80],
      previous: first.state,
    });

    expect(rolledOver.alerts.map((alert) => alert.threshold)).toEqual([80]);
  });

  it("repeats on the configured cadence and not before", () => {
    const start = Date.parse("2026-08-21T09:00:00.000Z");
    const first = evaluateProviderUsageAlerts({
      providers: [provider([session(87)])],
      thresholds: [80],
      repeatMinutes: 60,
      previous: new Map(),
      now: start,
    });
    const tooSoon = evaluateProviderUsageAlerts({
      providers: [provider([session(87)])],
      thresholds: [80],
      repeatMinutes: 60,
      previous: first.state,
      now: start + 59 * 60_000,
    });
    const due = evaluateProviderUsageAlerts({
      providers: [provider([session(87)])],
      thresholds: [80],
      repeatMinutes: 60,
      previous: tooSoon.state,
      now: start + 60 * 60_000,
    });

    expect(first.alerts).toHaveLength(1);
    expect(tooSoon.alerts).toEqual([]);
    expect(due.alerts).toHaveLength(1);
  });

  it("round-trips dedupe state through storage", () => {
    const evaluated = evaluateProviderUsageAlerts({
      providers: [provider([session(87)])],
      thresholds: [80],
      previous: new Map(),
    });
    const restored = deserializeProviderUsageAlertState(
      serializeProviderUsageAlertState(evaluated.state),
    );
    const afterReload = evaluateProviderUsageAlerts({
      providers: [provider([session(88)])],
      thresholds: [80],
      previous: restored,
    });

    expect(afterReload.alerts).toEqual([]);
    expect(deserializeProviderUsageAlertState("not json").size).toBe(0);
    expect(deserializeProviderUsageAlertState(null).size).toBe(0);
  });

  it("does not duplicate an alert when usage temporarily disappears", () => {
    const first = evaluateProviderUsageAlerts({
      providers: [provider([session(85)])],
      thresholds: [80],
      previous: new Map(),
    });
    const missing = evaluateProviderUsageAlerts({
      providers: [],
      thresholds: [80],
      previous: first.state,
    });
    const restored = evaluateProviderUsageAlerts({
      providers: [provider([session(86)])],
      thresholds: [80],
      previous: missing.state,
    });

    expect(missing.alerts).toEqual([]);
    expect(restored.alerts).toEqual([]);
  });

  it("normalizes comma-separated settings and permits blank to disable", () => {
    expect(parseProviderUsageAlertThresholds("80, 50; 80 101 nope")).toEqual([50, 80]);
    expect(parseProviderUsageAlertThresholds("  ")).toEqual([]);
    expect(normalizeProviderUsageAlertThresholds([90, 20, 20, 0, 50.5])).toEqual([20, 90]);
  });
});
