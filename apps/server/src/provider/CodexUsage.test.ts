import { describe, expect, it } from "vite-plus/test";

import { codexWindowLabel, normalizeCodexUsage } from "./CodexUsage.ts";

const CAPTURED_AT = "2026-07-17T09:00:00.000Z";

/** Epoch seconds, as `RateLimitWindow.resetsAt` ships them. */
const RESETS_AT_EPOCH_SECONDS = 1_784_286_600;
const RESETS_AT_ISO = "2026-07-17T11:10:00.000Z";

describe("normalizeCodexUsage — baseline read", () => {
  it("maps primary/secondary windows and the plan label", () => {
    const usage = normalizeCodexUsage({
      // `V2GetAccountRateLimitsResponse` shape.
      raw: {
        rateLimits: {
          planType: "plus",
          primary: {
            usedPercent: 23,
            resetsAt: RESETS_AT_EPOCH_SECONDS,
            windowDurationMins: 300,
          },
          secondary: { usedPercent: 61, resetsAt: null, windowDurationMins: 10_080 },
          credits: { hasCredits: true, unlimited: false },
        },
      },
      capturedAt: CAPTURED_AT,
      source: "probe",
    });

    expect(usage).toEqual({
      available: true,
      planLabel: "ChatGPT Plus",
      windows: [
        { id: "primary", label: "5h", percent: 23, resetsAt: RESETS_AT_ISO, windowMinutes: 300 },
        { id: "secondary", label: "Weekly", percent: 61, resetsAt: null, windowMinutes: 10_080 },
      ],
      capturedAt: CAPTURED_AT,
      source: "probe",
    });
  });

  it("unwraps the doubly-nested notification the adapter forwards whole", () => {
    // `CodexAdapter` sets `payload.rateLimits = event.payload`, and the
    // notification is itself `{ rateLimits: … }` — so ingestion sees two
    // levels of nesting.
    const usage = normalizeCodexUsage({
      raw: { rateLimits: { rateLimits: { primary: { usedPercent: 8 } } } },
      capturedAt: CAPTURED_AT,
      source: "event",
    });

    expect(usage?.windows).toEqual([
      { id: "primary", label: "Primary", percent: 8, resetsAt: null },
    ]);
  });

  it("accepts a bare RateLimitSnapshot", () => {
    const usage = normalizeCodexUsage({
      raw: { primary: { usedPercent: 8, windowDurationMins: 300 } },
      capturedAt: CAPTURED_AT,
      source: "event",
    });

    expect(usage?.windows).toEqual([
      { id: "primary", label: "5h", percent: 8, resetsAt: null, windowMinutes: 300 },
    ]);
  });
});

describe("normalizeCodexUsage — sparse rolling updates", () => {
  it("omits absent windows so a merge treats them as unchanged, not cleared", () => {
    const usage = normalizeCodexUsage({
      raw: { rateLimits: { primary: { usedPercent: 44, windowDurationMins: 300 } } },
      capturedAt: CAPTURED_AT,
      source: "event",
    });

    // `secondary` and `planType` are absent → they must not appear at all.
    // Emitting `secondary: null` here would blank a real window downstream.
    expect(usage?.windows.map((window) => window.id)).toEqual(["primary"]);
    expect(usage?.planLabel).toBeNull();
  });

  it("treats an explicitly null window the same as an absent one", () => {
    const usage = normalizeCodexUsage({
      raw: { rateLimits: { planType: null, primary: null, secondary: { usedPercent: 12 } } },
      capturedAt: CAPTURED_AT,
      source: "event",
    });

    expect(usage?.windows.map((window) => window.id)).toEqual(["secondary"]);
    expect(usage?.planLabel).toBeNull();
  });

  it("returns undefined when a push carries neither a window nor a plan", () => {
    for (const raw of [
      { rateLimits: {} },
      { rateLimits: { primary: null, secondary: null, planType: null } },
      { rateLimits: { credits: { hasCredits: true, unlimited: false } } },
    ]) {
      expect(
        normalizeCodexUsage({ raw, capturedAt: CAPTURED_AT, source: "event" }),
      ).toBeUndefined();
    }
  });
});

describe("normalizeCodexUsage — edge cases", () => {
  it("clamps out-of-range usedPercent", () => {
    const usage = normalizeCodexUsage({
      raw: { rateLimits: { primary: { usedPercent: 105 }, secondary: { usedPercent: -1 } } },
      capturedAt: CAPTURED_AT,
      source: "event",
    });

    expect(usage?.windows.map((window) => window.percent)).toEqual([100, 0]);
  });

  it("keeps a window whose usedPercent is unusable, with a null percent", () => {
    const usage = normalizeCodexUsage({
      raw: { rateLimits: { primary: { usedPercent: "lots" } } },
      capturedAt: CAPTURED_AT,
      source: "event",
    });

    expect(usage?.windows[0]?.percent).toBeNull();
  });

  it("accepts resetsAt already expressed in milliseconds", () => {
    const usage = normalizeCodexUsage({
      raw: { rateLimits: { primary: { usedPercent: 1, resetsAt: 1_784_286_600_000 } } },
      capturedAt: CAPTURED_AT,
      source: "event",
    });

    expect(usage?.windows[0]?.resetsAt).toBe(RESETS_AT_ISO);
  });

  it("degrades an unrecognized planType to no plan label", () => {
    const usage = normalizeCodexUsage({
      raw: { rateLimits: { planType: "quantum_tier", primary: { usedPercent: 5 } } },
      capturedAt: CAPTURED_AT,
      source: "event",
    });

    expect(usage?.planLabel).toBeNull();
  });

  it("returns undefined for payloads that carry no snapshot", () => {
    for (const raw of [undefined, null, 0, "", []]) {
      expect(
        normalizeCodexUsage({ raw, capturedAt: CAPTURED_AT, source: "event" }),
      ).toBeUndefined();
    }
  });
});

describe("codexWindowLabel", () => {
  it("names the durations the ChatGPT tiers actually ship", () => {
    expect(codexWindowLabel({ id: "primary", windowDurationMins: 300 })).toBe("5h");
    expect(codexWindowLabel({ id: "secondary", windowDurationMins: 10_080 })).toBe("Weekly");
    expect(codexWindowLabel({ id: "primary", windowDurationMins: 60 })).toBe("Hourly");
  });

  it("derives a label for unknown durations instead of falling back to the slot name", () => {
    expect(codexWindowLabel({ id: "primary", windowDurationMins: 30 })).toBe("30m");
    expect(codexWindowLabel({ id: "primary", windowDurationMins: 180 })).toBe("3h");
    expect(codexWindowLabel({ id: "secondary", windowDurationMins: 4320 })).toBe("3d");
  });

  it("falls back to the slot name when the duration is missing or nonsense", () => {
    expect(codexWindowLabel({ id: "primary", windowDurationMins: null })).toBe("Primary");
    expect(codexWindowLabel({ id: "secondary", windowDurationMins: undefined })).toBe("Secondary");
    expect(codexWindowLabel({ id: "primary", windowDurationMins: 0 })).toBe("Primary");
    expect(codexWindowLabel({ id: "primary", windowDurationMins: -5 })).toBe("Primary");
  });
});
