import { describe, expect, it } from "vite-plus/test";

import {
  attributeUsage,
  estimateBillableTokens,
  modelClassWeight,
  windowAcceptsModel,
  type UsageReadingPoint,
  type UsageWorkSample,
} from "./usageAttribution.ts";

const WEEK_RESET = "2026-09-14T00:00:00.000Z";
const NEXT_WEEK_RESET = "2026-09-21T00:00:00.000Z";

const reading = (
  capturedAt: string,
  percent: number | null,
  resetsAt: string | null = WEEK_RESET,
): UsageReadingPoint => ({ capturedAt, percent, resetsAt });

const sample = (
  at: string,
  overrides: Partial<UsageWorkSample> = {},
): UsageWorkSample => ({
  at,
  threadId: "thread-1",
  projectId: "project-a",
  projectTitle: "Project A",
  model: "claude-opus-5",
  tokens: 1000,
  ...overrides,
});

describe("estimateBillableTokens", () => {
  it("discounts the cached portion of the input", () => {
    const withCache = estimateBillableTokens({
      usedTokens: 100_000,
      lastInputTokens: 100_000,
      lastCachedInputTokens: 90_000,
      lastOutputTokens: 0,
    });
    // 10k fresh + 90k at a tenth.
    expect(withCache).toBe(19_000);
  });

  it("treats the whole input as fresh when the provider reports no cache split", () => {
    expect(
      estimateBillableTokens({
        usedTokens: 100_000,
        lastInputTokens: 100_000,
        lastOutputTokens: 0,
      }),
    ).toBe(100_000);
  });

  it("weights output above input", () => {
    expect(
      estimateBillableTokens({
        usedTokens: 1000,
        lastInputTokens: 0,
        lastOutputTokens: 1000,
      }),
    ).toBe(5000);
  });

  it("falls back to the whole-context figure when no per-response counts exist", () => {
    expect(estimateBillableTokens({ usedTokens: 4000, lastUsedTokens: 4000 })).toBe(4000);
  });
});

describe("modelClassWeight", () => {
  it("prices the heavier model class above the lighter ones", () => {
    expect(modelClassWeight("claude-opus-5")).toBeGreaterThan(modelClassWeight("claude-sonnet-5"));
    expect(modelClassWeight("claude-haiku-4-5")).toBeLessThan(modelClassWeight("claude-sonnet-5"));
  });

  it("treats an unknown or missing model as ordinary", () => {
    expect(modelClassWeight("gpt-6-astra")).toBe(1);
    expect(modelClassWeight(null)).toBe(1);
  });
});

describe("windowAcceptsModel", () => {
  it("keeps model-scoped windows to their own model", () => {
    expect(windowAcceptsModel("seven_day_opus", "claude-opus-5")).toBe(true);
    expect(windowAcceptsModel("seven_day_opus", "claude-sonnet-5")).toBe(false);
  });

  it("lets an unscoped window accept anything", () => {
    expect(windowAcceptsModel("seven_day", "claude-sonnet-5")).toBe(true);
    expect(windowAcceptsModel("primary", null)).toBe(true);
  });
});

describe("attributeUsage", () => {
  it("gives the whole rise to the only conversation that was running", () => {
    const periods = attributeUsage({
      windowId: "seven_day",
      readings: [reading("2026-09-09T10:00:00.000Z", 10), reading("2026-09-09T11:00:00.000Z", 18)],
      samples: [sample("2026-09-09T10:30:00.000Z")],
    });

    expect(periods).toHaveLength(1);
    expect(periods[0]?.observedPercent).toBe(8);
    expect(periods[0]?.attributedPercent).toBe(8);
    expect(periods[0]?.elsewherePercent).toBe(0);
    expect(periods[0]?.allocations).toEqual([
      expect.objectContaining({ projectId: "project-a", percent: 8 }),
    ]);
  });

  it("splits an interval between concurrent conversations by how much work each did", () => {
    const periods = attributeUsage({
      windowId: "seven_day",
      readings: [reading("2026-09-09T10:00:00.000Z", 0), reading("2026-09-09T11:00:00.000Z", 12)],
      samples: [
        sample("2026-09-09T10:10:00.000Z", { projectId: "project-a", tokens: 3000 }),
        sample("2026-09-09T10:20:00.000Z", {
          projectId: "project-b",
          projectTitle: "Project B",
          threadId: "thread-2",
          tokens: 1000,
        }),
      ],
    });

    const allocations = periods[0]?.allocations ?? [];
    expect(allocations.map((allocation) => allocation.projectId)).toEqual([
      "project-a",
      "project-b",
    ]);
    expect(allocations[0]?.percent).toBeCloseTo(9);
    expect(allocations[1]?.percent).toBeCloseTo(3);
  });

  it("weights a heavier model above a lighter one running at the same time", () => {
    const periods = attributeUsage({
      windowId: "seven_day",
      readings: [reading("2026-09-09T10:00:00.000Z", 0), reading("2026-09-09T11:00:00.000Z", 12)],
      samples: [
        sample("2026-09-09T10:10:00.000Z", { model: "claude-opus-5", tokens: 1000 }),
        sample("2026-09-09T10:20:00.000Z", {
          model: "claude-sonnet-5",
          projectId: "project-b",
          projectTitle: "Project B",
          tokens: 1000,
        }),
      ],
    });

    const allocations = periods[0]?.allocations ?? [];
    expect(allocations[0]?.model).toBe("claude-opus-5");
    expect(allocations[0]?.percent).toBeCloseTo(10);
    expect(allocations[1]?.percent).toBeCloseTo(2);
  });

  it("books a rise with no recorded work as consumed elsewhere", () => {
    const periods = attributeUsage({
      windowId: "seven_day",
      readings: [reading("2026-09-09T10:00:00.000Z", 5), reading("2026-09-09T11:00:00.000Z", 21)],
      samples: [],
    });

    expect(periods[0]?.elsewherePercent).toBe(16);
    expect(periods[0]?.attributedPercent).toBe(0);
    expect(periods[0]?.allocations).toEqual([]);
  });

  it("reports what was already spent before observation began", () => {
    const periods = attributeUsage({
      windowId: "seven_day",
      readings: [reading("2026-09-09T10:00:00.000Z", 40), reading("2026-09-09T11:00:00.000Z", 45)],
      samples: [sample("2026-09-09T10:30:00.000Z")],
    });

    expect(periods[0]?.openingPercent).toBe(40);
    expect(periods[0]?.closingPercent).toBe(45);
    expect(periods[0]?.observedPercent).toBe(5);
  });

  it("never carries a rise across a window reset", () => {
    const periods = attributeUsage({
      windowId: "seven_day",
      readings: [
        reading("2026-09-09T10:00:00.000Z", 80),
        reading("2026-09-14T01:00:00.000Z", 3, NEXT_WEEK_RESET),
        reading("2026-09-14T02:00:00.000Z", 9, NEXT_WEEK_RESET),
      ],
      samples: [sample("2026-09-14T01:30:00.000Z")],
    });

    expect(periods).toHaveLength(2);
    // Newest period first.
    expect(periods[0]?.resetsAt).toBe(NEXT_WEEK_RESET);
    expect(periods[0]?.observedPercent).toBe(6);
    expect(periods[1]?.observedPercent).toBe(0);
  });

  it("ignores a flat or falling reading rather than inventing credit", () => {
    const periods = attributeUsage({
      windowId: "seven_day",
      readings: [
        reading("2026-09-09T10:00:00.000Z", 20),
        reading("2026-09-09T10:30:00.000Z", 20),
        reading("2026-09-09T11:00:00.000Z", 19),
      ],
      samples: [sample("2026-09-09T10:45:00.000Z")],
    });

    expect(periods[0]?.observedPercent).toBe(0);
    expect(periods[0]?.allocations).toEqual([]);
  });

  it("keeps work on another model out of a model-scoped window", () => {
    const periods = attributeUsage({
      windowId: "seven_day_opus",
      readings: [reading("2026-09-09T10:00:00.000Z", 0), reading("2026-09-09T11:00:00.000Z", 10)],
      samples: [
        sample("2026-09-09T10:10:00.000Z", { model: "claude-sonnet-5" }),
        sample("2026-09-09T10:20:00.000Z", { model: "claude-opus-5" }),
      ],
    });

    expect(periods[0]?.allocations).toHaveLength(1);
    expect(periods[0]?.allocations[0]?.model).toBe("claude-opus-5");
    expect(periods[0]?.allocations[0]?.percent).toBe(10);
  });

  it("skips readings the provider declined to put a number on", () => {
    const periods = attributeUsage({
      windowId: "seven_day",
      readings: [
        reading("2026-09-09T10:00:00.000Z", 4),
        reading("2026-09-09T10:30:00.000Z", null),
        reading("2026-09-09T11:00:00.000Z", 10),
      ],
      samples: [sample("2026-09-09T10:45:00.000Z")],
    });

    expect(periods[0]?.observedPercent).toBe(6);
    expect(periods[0]?.attributedPercent).toBe(6);
  });

  it("returns nothing when the tape is empty", () => {
    expect(attributeUsage({ windowId: "seven_day", readings: [], samples: [] })).toEqual([]);
  });
});
