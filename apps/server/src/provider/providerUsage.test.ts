import type { ServerProviderUsage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { normalizeClaudeUsage } from "./ClaudeUsage.ts";
import { normalizeCodexUsage } from "./CodexUsage.ts";
import { mergeProviderUsage } from "./providerUsage.ts";

const PROBE_AT = "2026-07-17T09:00:00.000Z";
const EVENT_AT = "2026-07-17T09:30:00.000Z";

const baseline: ServerProviderUsage = {
  available: true,
  planLabel: "max",
  windows: [
    { id: "five_hour", label: "Session", percent: 10, resetsAt: "2026-07-17T11:10:00.000Z" },
    { id: "seven_day", label: "Weekly", percent: 4, resetsAt: "2026-07-21T08:00:00.000Z" },
  ],
  capturedAt: PROBE_AT,
  source: "probe",
};

describe("mergeProviderUsage", () => {
  it("returns the update verbatim when there is nothing to merge into", () => {
    expect(mergeProviderUsage(undefined, baseline)).toBe(baseline);
  });

  it("updates only the windows the sparse push carries", () => {
    const merged = mergeProviderUsage(baseline, {
      available: true,
      planLabel: null,
      windows: [{ id: "five_hour", label: "Session", percent: 82, resetsAt: null }],
      capturedAt: EVENT_AT,
      source: "event",
    });

    expect(merged.windows).toEqual([
      { id: "five_hour", label: "Session", percent: 82, resetsAt: null },
      // Untouched by the push — must survive rather than being cleared.
      { id: "seven_day", label: "Weekly", percent: 4, resetsAt: "2026-07-21T08:00:00.000Z" },
    ]);
  });

  it("keeps the previous planLabel when the push omits it", () => {
    const merged = mergeProviderUsage(baseline, {
      available: true,
      planLabel: null,
      windows: [],
      capturedAt: EVENT_AT,
      source: "event",
    });

    expect(merged.planLabel).toBe("max");
  });

  it("lets a push override a stale planLabel", () => {
    const merged = mergeProviderUsage(baseline, {
      available: true,
      planLabel: "pro",
      windows: [],
      capturedAt: EVENT_AT,
      source: "event",
    });

    expect(merged.planLabel).toBe("pro");
  });

  it("stamps capturedAt and source from the freshest observation", () => {
    const merged = mergeProviderUsage(baseline, {
      available: true,
      planLabel: null,
      windows: [],
      capturedAt: EVENT_AT,
      source: "event",
    });

    expect(merged.capturedAt).toBe(EVENT_AT);
    expect(merged.source).toBe("event");
  });

  it("preserves window order and appends genuinely new windows", () => {
    const merged = mergeProviderUsage(baseline, {
      available: true,
      planLabel: null,
      windows: [
        { id: "seven_day", label: "Weekly", percent: 9, resetsAt: null },
        { id: "seven_day_opus", label: "Weekly (Opus)", percent: 50, resetsAt: null },
      ],
      capturedAt: EVENT_AT,
      source: "event",
    });

    expect(merged.windows.map((window) => window.id)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_opus",
    ]);
  });

  it("replaces outright when plan limits stop applying", () => {
    const unavailable: ServerProviderUsage = {
      available: false,
      planLabel: null,
      windows: [],
      capturedAt: EVENT_AT,
      source: "probe",
      message: "Plan rate limits do not apply to this Claude session.",
    };

    // Every previously known window is invalidated — merging them through
    // would keep rendering limits that no longer exist.
    expect(mergeProviderUsage(baseline, unavailable)).toBe(unavailable);
  });

  it("replaces outright when plan limits start applying again", () => {
    const unavailable: ServerProviderUsage = {
      available: false,
      planLabel: null,
      windows: [],
      capturedAt: PROBE_AT,
      source: "probe",
    };

    expect(mergeProviderUsage(unavailable, baseline)).toBe(baseline);
  });
});

describe("mergeProviderUsage — end-to-end with the normalizers", () => {
  it("keeps Claude's probed windows alive across a single-window event push", () => {
    // The exact regression the merge exists for: Claude's `rate_limit_event`
    // describes one window, so replacing would drop `seven_day` entirely.
    const probed = normalizeClaudeUsage({
      raw: {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 0, resets_at: "2026-07-17T11:10:00Z" },
          seven_day: { utilization: 4, resets_at: "2026-07-21T08:00:00Z" },
        },
      },
      capturedAt: PROBE_AT,
    });
    const pushed = normalizeClaudeUsage({
      raw: {
        rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 82 },
      },
      capturedAt: EVENT_AT,
    });

    const merged = mergeProviderUsage(probed, pushed!);

    expect(merged.planLabel).toBe("max");
    expect(merged.windows).toEqual([
      { id: "five_hour", label: "Session", percent: 82, resetsAt: null, severity: "warning" },
      { id: "seven_day", label: "Weekly", percent: 4, resetsAt: "2026-07-21T08:00:00.000Z" },
    ]);
  });

  it("keeps Codex's planType and secondary window across a sparse rolling update", () => {
    // The Codex schema is explicit that a null in a rolling update means
    // "unchanged", not "cleared" — so `planType` and `secondary` must survive
    // a push that only moves `primary`.
    const probed = normalizeCodexUsage({
      raw: {
        rateLimits: {
          planType: "plus",
          primary: { usedPercent: 20, windowDurationMins: 300 },
          secondary: { usedPercent: 61, windowDurationMins: 10_080 },
        },
      },
      capturedAt: PROBE_AT,
      source: "probe",
    });
    const pushed = normalizeCodexUsage({
      raw: {
        rateLimits: { rateLimits: { primary: { usedPercent: 55, windowDurationMins: 300 } } },
      },
      capturedAt: EVENT_AT,
      source: "event",
    });

    const merged = mergeProviderUsage(probed, pushed!);

    expect(merged.planLabel).toBe("ChatGPT Plus");
    expect(merged.windows).toEqual([
      { id: "primary", label: "5h", percent: 55, resetsAt: null },
      { id: "secondary", label: "Weekly", percent: 61, resetsAt: null },
    ]);
  });
});
