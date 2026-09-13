import { describe, expect, it } from "vite-plus/test";

import { normalizeClaudeUsage } from "./ClaudeUsage.ts";

const CAPTURED_AT = "2026-07-17T09:00:00.000Z";

/**
 * Shaped after a real `SDKControlGetUsageResponse` from a Max account. Trimmed
 * to the fields the normalizer reads — `session`, `behaviors`, etc. are
 * deliberately absent to prove they aren't required.
 */
const maxProbeResponse = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 0, resets_at: "2026-07-17T11:10:00Z" },
    seven_day: { utilization: 4, resets_at: "2026-07-21T08:00:00Z" },
  },
};

describe("normalizeClaudeUsage — probe response", () => {
  it("maps named windows to ids that match the event stream's rateLimitType", () => {
    const usage = normalizeClaudeUsage({ raw: maxProbeResponse, capturedAt: CAPTURED_AT });

    expect(usage).toEqual({
      available: true,
      planLabel: "max",
      windows: [
        {
          id: "five_hour",
          label: "Session",
          percent: 0,
          resetsAt: "2026-07-17T11:10:00.000Z",
          windowMinutes: 300,
        },
        {
          id: "seven_day",
          label: "Weekly",
          percent: 4,
          resetsAt: "2026-07-21T08:00:00.000Z",
          windowMinutes: 10_080,
        },
      ],
      capturedAt: CAPTURED_AT,
      source: "probe",
    });
  });

  it("labels the per-model weekly windows distinctly", () => {
    const usage = normalizeClaudeUsage({
      raw: {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          seven_day_opus: { utilization: 12, resets_at: "2026-07-21T08:00:00Z" },
          seven_day_sonnet: { utilization: 30, resets_at: "2026-07-21T08:00:00Z" },
        },
      },
      capturedAt: CAPTURED_AT,
    });

    expect(usage?.windows.map((window) => [window.id, window.label])).toEqual([
      ["seven_day_opus", "Weekly (Opus)"],
      ["seven_day_sonnet", "Weekly (Sonnet)"],
    ]);
  });

  it("reports unavailable for API-key / Bedrock / Vertex sessions", () => {
    const usage = normalizeClaudeUsage({
      raw: { subscription_type: null, rate_limits_available: false, rate_limits: null },
      capturedAt: CAPTURED_AT,
    });

    expect(usage).toEqual({
      available: false,
      planLabel: null,
      windows: [],
      capturedAt: CAPTURED_AT,
      source: "probe",
      message: "Plan rate limits do not apply to this Claude session.",
    });
  });

  it("keeps a window whose utilization is unknown, with a null percent", () => {
    const usage = normalizeClaudeUsage({
      raw: {
        subscription_type: "pro",
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: null, resets_at: null } },
      },
      capturedAt: CAPTURED_AT,
    });

    // `percent: null` says "the window exists but utilization is unknown",
    // which is different from omitting the window entirely.
    expect(usage?.windows).toEqual([
      { id: "five_hour", label: "Session", percent: null, resetsAt: null, windowMinutes: 300 },
    ]);
  });

  it("omits windows the response does not carry", () => {
    const usage = normalizeClaudeUsage({
      raw: {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 1, resets_at: null }, seven_day: null },
      },
      capturedAt: CAPTURED_AT,
    });

    expect(usage?.windows.map((window) => window.id)).toEqual(["five_hour"]);
  });

  it("clamps out-of-range utilization rather than dropping a spent window", () => {
    const usage = normalizeClaudeUsage({
      raw: {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 140, resets_at: null },
          seven_day: { utilization: -3, resets_at: null },
        },
      },
      capturedAt: CAPTURED_AT,
    });

    expect(usage?.windows.map((window) => window.percent)).toEqual([100, 0]);
  });

  it("rejects an unparseable resets_at instead of emitting Invalid Date", () => {
    const usage = normalizeClaudeUsage({
      raw: {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 5, resets_at: "not-a-timestamp" } },
      },
      capturedAt: CAPTURED_AT,
    });

    expect(usage?.windows[0]?.resetsAt).toBeNull();
  });
});

describe("normalizeClaudeUsage — undeclared rate_limits.limits[]", () => {
  // `limits[]` ships at runtime but is absent from the installed SDK's
  // typedef, so it is read only as a best-effort fallback. These tests pin
  // that it enriches named windows and repairs missing standard percentages
  // without making unknown kinds load-bearing.
  it("enriches severity onto the matching named windows", () => {
    const usage = normalizeClaudeUsage({
      raw: {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 91, resets_at: null },
          seven_day: { utilization: 40, resets_at: null },
          seven_day_opus: { utilization: 99, resets_at: null },
          limits: [
            { kind: "session", percent: 91, severity: "warning", is_active: true },
            { kind: "weekly_all", percent: 40, severity: "normal", is_active: true },
            {
              kind: "weekly_scoped",
              percent: 99,
              severity: "critical",
              scope: { model: { display_name: "Opus" } },
              is_active: true,
            },
          ],
        },
      },
      capturedAt: CAPTURED_AT,
    });

    expect(usage?.windows.map((window) => [window.id, window.severity])).toEqual([
      ["five_hour", "warning"],
      ["seven_day", "normal"],
      ["seven_day_opus", "critical"],
    ]);
  });

  it("uses limits percent when the named session utilization is null", () => {
    const usage = normalizeClaudeUsage({
      raw: {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: null, resets_at: "2026-07-17T11:10:00Z" },
          seven_day: { utilization: 11, resets_at: null },
          limits: [{ kind: "session", percent: 18, severity: "normal", is_active: true }],
        },
      },
      capturedAt: CAPTURED_AT,
    });

    expect(usage?.windows).toEqual([
      {
        id: "five_hour",
        label: "Session",
        percent: 18,
        resetsAt: "2026-07-17T11:10:00.000Z",
        severity: "normal",
        windowMinutes: 300,
      },
      { id: "seven_day", label: "Weekly", percent: 11, resetsAt: null, windowMinutes: 10_080 },
    ]);
  });

  it("synthesizes a standard window when only limits carries it", () => {
    const usage = normalizeClaudeUsage({
      raw: {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          limits: [
            {
              kind: "session",
              percent: 64,
              severity: "warning",
              resets_at: "2026-07-17T11:10:00Z",
              is_active: true,
            },
          ],
        },
      },
      capturedAt: CAPTURED_AT,
    });

    expect(usage?.windows).toEqual([
      {
        id: "five_hour",
        label: "Session",
        percent: 64,
        resetsAt: "2026-07-17T11:10:00.000Z",
        severity: "warning",
        windowMinutes: 300,
      },
    ]);
  });

  it("ignores inactive limits", () => {
    const usage = normalizeClaudeUsage({
      raw: {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 10, resets_at: null },
          limits: [{ kind: "session", severity: "critical", is_active: false }],
        },
      },
      capturedAt: CAPTURED_AT,
    });

    expect(usage?.windows[0]?.severity).toBeUndefined();
  });

  it("survives limits[] being absent, malformed, or an unexpected shape", () => {
    for (const limits of [undefined, null, "nonsense", 42, [null, {}, { kind: "who_knows" }]]) {
      const usage = normalizeClaudeUsage({
        raw: {
          subscription_type: "max",
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 10, resets_at: null }, limits },
        },
        capturedAt: CAPTURED_AT,
      });

      expect(usage?.windows).toEqual([
        { id: "five_hour", label: "Session", percent: 10, resetsAt: null, windowMinutes: 300 },
      ]);
    }
  });
});

describe("normalizeClaudeUsage — rate_limit_event push", () => {
  it("normalizes the single pushed window, converting the epoch reset to ISO", () => {
    const usage = normalizeClaudeUsage({
      raw: {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 82,
          resetsAt: 1_784_286_600,
        },
        uuid: "u",
        session_id: "s",
      },
      capturedAt: CAPTURED_AT,
    });

    expect(usage).toEqual({
      available: true,
      // Null on purpose: the event says nothing about the plan, and
      // `mergeProviderUsage` restores the probed label rather than blanking it.
      planLabel: null,
      windows: [
        {
          id: "five_hour",
          label: "Session",
          percent: 82,
          resetsAt: "2026-07-17T11:10:00.000Z",
          severity: "warning",
          windowMinutes: 300,
        },
      ],
      capturedAt: CAPTURED_AT,
      source: "event",
    });
  });

  it("maps status onto the severity scale", () => {
    const severityFor = (status: string) =>
      normalizeClaudeUsage({
        raw: { rate_limit_info: { status, rateLimitType: "seven_day", utilization: 1 } },
        capturedAt: CAPTURED_AT,
      })?.windows[0]?.severity;

    expect(severityFor("allowed")).toBe("normal");
    expect(severityFor("allowed_warning")).toBe("warning");
    expect(severityFor("rejected")).toBe("critical");
    expect(severityFor("something_new")).toBeUndefined();
  });

  it("accepts an epoch reset already expressed in milliseconds", () => {
    const usage = normalizeClaudeUsage({
      raw: {
        rate_limit_info: {
          status: "allowed",
          rateLimitType: "five_hour",
          utilization: 3,
          resetsAt: 1_784_286_600_000,
        },
      },
      capturedAt: CAPTURED_AT,
    });

    expect(usage?.windows[0]?.resetsAt).toBe("2026-07-17T11:10:00.000Z");
  });

  it("labels an unknown rateLimitType generically instead of dropping it", () => {
    const usage = normalizeClaudeUsage({
      raw: { rate_limit_info: { status: "allowed", rateLimitType: "monthly_new", utilization: 7 } },
      capturedAt: CAPTURED_AT,
    });

    expect(usage?.windows).toEqual([
      { id: "monthly_new", label: "Plan limit", percent: 7, resetsAt: null, severity: "normal" },
    ]);
  });

  it("reads a fractional utilization as a percentage", () => {
    // The push ships `0.31` for a window the probe reports as `31`. Taken at
    // face value it renders as "0.3%", which says a third-spent window is
    // untouched.
    const usage = normalizeClaudeUsage({
      raw: {
        rate_limit_info: { status: "allowed", rateLimitType: "seven_day", utilization: 0.31 },
      },
      capturedAt: CAPTURED_AT,
    });

    expect(usage?.windows[0]?.percent).toBeCloseTo(31);
  });

  it("carries every window the push describes, not only the one it names", () => {
    // Session pushes never restate their own utilization, but they do carry
    // the numbers for both windows alongside — which is what keeps the session
    // reading alive between probes.
    const usage = normalizeClaudeUsage({
      raw: {
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.31,
          resetsAt: 1_789_459_200,
          unifiedWindows: {
            five_hour: { utilization: 0.48, resetsAt: 1_788_946_800 },
            seven_day: { utilization: 0.31, resetsAt: 1_789_459_200 },
          },
        },
      },
      capturedAt: CAPTURED_AT,
    });

    const byId = new Map(usage?.windows.map((window) => [window.id, window]));
    expect(byId.get("five_hour")?.percent).toBeCloseTo(48);
    expect(byId.get("seven_day")?.percent).toBeCloseTo(31);
    // Severity belongs to the window the push is actually about.
    expect(byId.get("seven_day")?.severity).toBe("warning");
    expect(byId.get("five_hour")?.severity).toBeUndefined();
  });

  it("falls back to the accompanying window when the named one omits its number", () => {
    const usage = normalizeClaudeUsage({
      raw: {
        rate_limit_info: {
          status: "allowed",
          rateLimitType: "five_hour",
          resetsAt: 1_788_946_800,
          unifiedWindows: {
            five_hour: { utilization: 0.48, resetsAt: 1_788_946_800 },
            seven_day: { utilization: 0.31, resetsAt: 1_789_459_200 },
          },
        },
      },
      capturedAt: CAPTURED_AT,
    });

    const session = usage?.windows.find((window) => window.id === "five_hour");
    expect(session?.percent).toBeCloseTo(48);
  });

  it("returns undefined when the event names no window", () => {
    expect(
      normalizeClaudeUsage({
        raw: { rate_limit_info: { status: "allowed" } },
        capturedAt: CAPTURED_AT,
      }),
    ).toBeUndefined();
  });
});

describe("normalizeClaudeUsage — unrecognized payloads", () => {
  it("returns undefined rather than publishing an empty usage", () => {
    for (const raw of [undefined, null, 0, "", [], { unrelated: true }, { rate_limits: {} }]) {
      expect(normalizeClaudeUsage({ raw, capturedAt: CAPTURED_AT })).toBeUndefined();
    }
  });
});
