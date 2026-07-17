import { describe, expect, it } from "vite-plus/test";
import type { ServerProvider, ServerProviderUsage } from "@t3tools/contracts";

import {
  formatProviderUsageResetLabel,
  formatProviderUsageStaleLabel,
  getProviderUsageSummary,
} from "./providerStatus";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");

function isoAfter(now: number, ms: number): string {
  return new Date(now + ms).toISOString();
}

/**
 * Minimal provider snapshot. Only the fields `getProviderUsageSummary` reads
 * matter, so the rest of `ServerProvider` is cast past rather than mirrored —
 * mirroring it would make these tests fail on unrelated contract changes.
 */
function providerWithUsage(usage: ServerProviderUsage | undefined): ServerProvider {
  return { usage } as unknown as ServerProvider;
}

function usage(overrides: Partial<ServerProviderUsage> = {}): ServerProviderUsage {
  return {
    available: true,
    planLabel: "max",
    windows: [],
    capturedAt: new Date(NOW).toISOString(),
    source: "event",
    ...overrides,
  } as ServerProviderUsage;
}

describe("formatProviderUsageResetLabel", () => {
  it("formats sub-hour, hour and multi-day countdowns", () => {
    expect(formatProviderUsageResetLabel(isoAfter(NOW, 45 * 60_000), NOW)).toBe("Resets in 45m");
    expect(formatProviderUsageResetLabel(isoAfter(NOW, 134 * 60_000), NOW)).toBe(
      "Resets in 2h 14m",
    );
    expect(formatProviderUsageResetLabel(isoAfter(NOW, 3 * 60 * 60_000), NOW)).toBe("Resets in 3h");
    expect(formatProviderUsageResetLabel(isoAfter(NOW, 76 * 60 * 60_000), NOW)).toBe(
      "Resets in 3d 4h",
    );
    expect(formatProviderUsageResetLabel(isoAfter(NOW, 72 * 60 * 60_000), NOW)).toBe(
      "Resets in 3d",
    );
  });

  it("rounds down so a countdown never promises a reset early", () => {
    // 2h59m59s must read as 2h 59m, never 3h.
    expect(
      formatProviderUsageResetLabel(isoAfter(NOW, 2 * 60 * 60_000 + 59 * 60_000 + 59_000), NOW),
    ).toBe("Resets in 2h 59m");
  });

  it("collapses past and imminent resets rather than counting negative", () => {
    expect(formatProviderUsageResetLabel(isoAfter(NOW, -60 * 60_000), NOW)).toBe("Resets shortly");
    expect(formatProviderUsageResetLabel(isoAfter(NOW, 30_000), NOW)).toBe("Resets shortly");
  });

  it("returns null for absent or unparseable timestamps", () => {
    expect(formatProviderUsageResetLabel(null, NOW)).toBeNull();
    expect(formatProviderUsageResetLabel("not-a-date", NOW)).toBeNull();
  });
});

describe("formatProviderUsageStaleLabel", () => {
  it("stays quiet while the capture is recent", () => {
    expect(formatProviderUsageStaleLabel(isoAfter(NOW, -60_000), NOW)).toBeNull();
    expect(formatProviderUsageStaleLabel(isoAfter(NOW, -4 * 60_000), NOW)).toBeNull();
  });

  it("reports age once the capture is meaningfully old", () => {
    expect(formatProviderUsageStaleLabel(isoAfter(NOW, -12 * 60_000), NOW)).toBe("Updated 12m ago");
    expect(formatProviderUsageStaleLabel(isoAfter(NOW, -90 * 60_000), NOW)).toBe(
      "Updated 1h 30m ago",
    );
  });

  it("returns null for an unparseable capture", () => {
    expect(formatProviderUsageStaleLabel("nope", NOW)).toBeNull();
  });

  it("stays quiet when the server clock is ahead of the client", () => {
    // Clock skew makes capturedAt look like the future. That must read as
    // "fresh", never as a negative age.
    expect(formatProviderUsageStaleLabel(isoAfter(NOW, 10 * 60_000), NOW)).toBeNull();
  });
});

describe("getProviderUsageSummary", () => {
  it("reports unknown for a missing provider or absent usage", () => {
    // Absent usage is the steady state for the first seconds after boot and
    // forever for providers without plan limits. Neither is an error.
    expect(getProviderUsageSummary(undefined, NOW)).toEqual({ kind: "unknown" });
    expect(getProviderUsageSummary(providerWithUsage(undefined), NOW)).toEqual({ kind: "unknown" });
  });

  it("distinguishes unavailable from unknown, preferring the server's message", () => {
    expect(
      getProviderUsageSummary(
        providerWithUsage(usage({ available: false, message: "Using an API key." })),
        NOW,
      ),
    ).toEqual({ kind: "unavailable", detail: "Using an API key." });

    expect(getProviderUsageSummary(providerWithUsage(usage({ available: false })), NOW)).toEqual({
      kind: "unavailable",
      detail: "Plan limits don't apply to this account.",
    });
  });

  it("formats windows and picks the closest-to-limit window as the headline", () => {
    const summary = getProviderUsageSummary(
      providerWithUsage(
        usage({
          windows: [
            { id: "five_hour", label: "5-hour", percent: 12, resetsAt: isoAfter(NOW, 60 * 60_000) },
            { id: "weekly", label: "Weekly", percent: 81, resetsAt: null },
          ],
        }),
      ),
      NOW,
    );

    expect(summary.kind).toBe("measured");
    if (summary.kind !== "measured") return;
    expect(summary.planLabel).toBe("max");
    expect(summary.headline?.id).toBe("weekly");
    // 81% crosses the warning cutoff.
    expect(summary.headline?.severity).toBe("warning");
    expect(summary.windows[0]?.percentLabel).toBe("12%");
    expect(summary.windows[0]?.resetLabel).toBe("Resets in 1h");
    expect(summary.windows[1]?.resetLabel).toBeNull();
    expect(summary.staleLabel).toBeNull();
  });

  it("keeps a null percent distinct from zero", () => {
    const summary = getProviderUsageSummary(
      providerWithUsage(
        usage({ windows: [{ id: "weekly", label: "Weekly", percent: null, resetsAt: null }] }),
      ),
      NOW,
    );

    expect(summary.kind).toBe("measured");
    if (summary.kind !== "measured") return;
    // A window with unknown utilization must not become the headline, and
    // must not be styled as if it were empty.
    expect(summary.headline).toBeNull();
    expect(summary.windows[0]?.percentLabel).toBeNull();
    expect(summary.windows[0]?.severity).toBe("normal");
  });

  it("picks the highest percent as headline even when a null-percent window sorts first", () => {
    // Regression: a null percent must not be treated as 0 and must not
    // shadow a real window when it appears earlier in the array.
    const summary = getProviderUsageSummary(
      providerWithUsage(
        usage({
          windows: [
            { id: "unknown", label: "Unknown", percent: null, resetsAt: null },
            { id: "five_hour", label: "5-hour", percent: 3, resetsAt: null },
          ],
        }),
      ),
      NOW,
    );

    expect(summary.kind).toBe("measured");
    if (summary.kind !== "measured") return;
    expect(summary.headline?.id).toBe("five_hour");
  });

  it("treats an available provider with no windows as measured but empty", () => {
    const summary = getProviderUsageSummary(providerWithUsage(usage({ windows: [] })), NOW);

    expect(summary.kind).toBe("measured");
    if (summary.kind !== "measured") return;
    expect(summary.windows).toEqual([]);
    expect(summary.headline).toBeNull();
  });

  it("prefers the provider's own severity over the inferred one", () => {
    const summary = getProviderUsageSummary(
      providerWithUsage(
        usage({
          windows: [{ id: "w", label: "Weekly", percent: 5, resetsAt: null, severity: "critical" }],
        }),
      ),
      NOW,
    );

    expect(summary.kind).toBe("measured");
    if (summary.kind !== "measured") return;
    expect(summary.windows[0]?.severity).toBe("critical");
  });

  it("infers critical at the 90% cutoff", () => {
    const summary = getProviderUsageSummary(
      providerWithUsage(
        usage({ windows: [{ id: "w", label: "5-hour", percent: 90, resetsAt: null }] }),
      ),
      NOW,
    );

    expect(summary.kind).toBe("measured");
    if (summary.kind !== "measured") return;
    expect(summary.headline?.severity).toBe("critical");
  });

  it("ranks the headline by severity before utilization", () => {
    // The meter takes both its length and its colour from `headline`, so the
    // provider-flagged critical window must win over a merely larger one —
    // otherwise the dial paints a 50% arc in a colour describing a different
    // window entirely.
    const summary = getProviderUsageSummary(
      providerWithUsage(
        usage({
          windows: [
            { id: "big", label: "Weekly", percent: 50, resetsAt: null },
            { id: "urgent", label: "5-hour", percent: 20, resetsAt: null, severity: "critical" },
          ],
        }),
      ),
      NOW,
    );

    expect(summary.kind).toBe("measured");
    if (summary.kind !== "measured") return;
    expect(summary.headline?.id).toBe("urgent");
    expect(summary.headline?.severity).toBe("critical");
  });

  it("surfaces staleness from capturedAt", () => {
    const summary = getProviderUsageSummary(
      providerWithUsage(usage({ capturedAt: isoAfter(NOW, -30 * 60_000) })),
      NOW,
    );

    expect(summary.kind).toBe("measured");
    if (summary.kind !== "measured") return;
    expect(summary.staleLabel).toBe("Updated 30m ago");
  });
});
