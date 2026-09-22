import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsage,
} from "@t3tools/contracts";
import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { ComposerUsageMeter } from "./ComposerUsageMeter";
import type { ContextWindowSnapshot } from "../../lib/contextWindow";
import type { ProviderInstanceEntry } from "../../providerInstances";

const CONTEXT_WINDOW: ContextWindowSnapshot = {
  usedTokens: 15_400,
  totalProcessedTokens: 77_000,
  maxTokens: 200_000,
  remainingTokens: 184_600,
  usedPercentage: 7.7,
  remainingPercentage: 92.3,
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  lastUsedTokens: null,
  lastInputTokens: null,
  lastCachedInputTokens: null,
  lastOutputTokens: null,
  lastReasoningOutputTokens: null,
  toolUses: null,
  durationMs: null,
  compactsAutomatically: false,
  updatedAt: "2026-08-12T09:00:00.000Z",
};

function usage(planLabel: string, percent: number): ServerProviderUsage {
  return {
    available: true,
    planLabel,
    windows: [
      { id: "five_hour", label: "5-hour window", percent, resetsAt: null },
      { id: "weekly", label: "Weekly", percent: percent / 2, resetsAt: null },
    ],
    // Recent enough that the staleness note stays quiet; the clock is real here.
    capturedAt: new Date().toISOString(),
    source: "event",
  };
}

function instanceEntry(
  instanceId: string,
  displayName: string,
  providerUsage: ServerProviderUsage,
): ProviderInstanceEntry {
  const id = ProviderInstanceId.make(instanceId);
  const driverKind = ProviderDriverKind.make(instanceId);
  const snapshot = {
    instanceId: id,
    driver: driverKind,
    displayName,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { kind: "unknown" },
    checkedAt: "2026-08-12T09:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    usage: providerUsage,
  } as unknown as ServerProvider;

  return {
    instanceId: id,
    driverKind,
    displayName,
    enabled: true,
    installed: true,
    status: "ready" as ProviderInstanceEntry["status"],
    isDefault: true,
    isAvailable: true,
    snapshot,
    models: [],
  };
}

const ENTRIES = [
  instanceEntry("claudeAgent", "Claude", usage("Max 20x", 42)),
  instanceEntry("codex", "Codex", usage("Plus", 88)),
];

/**
 * A five-hour window one hour in, with `percent` already spent — enough
 * elapsed for the burn-rate projection to be worth showing.
 */
function pacedUsage(percent: number): ServerProviderUsage {
  const now = Date.now();
  return {
    available: true,
    planLabel: "Max 20x",
    windows: [
      {
        id: "five_hour",
        label: "Session",
        percent,
        resetsAt: new Date(now + 4 * 60 * 60_000).toISOString(),
        windowMinutes: 300,
      },
    ],
    capturedAt: new Date(now).toISOString(),
    source: "event",
  };
}

/** Mirrors the composer: a rounded, bordered surface with the meter floated in. */
async function mountMeter(options?: {
  contextWindow?: ContextWindowSnapshot | null;
  entries?: ReadonlyArray<ProviderInstanceEntry>;
}) {
  const host = document.createElement("div");
  host.style.width = "640px";
  document.body.append(host);

  const screen = await render(
    <div
      data-testid="composer-surface"
      className="relative rounded-[20px] border bg-card px-3 pb-2 pt-3.5"
    >
      <ComposerUsageMeter
        className="absolute right-0.5 top-0.5 z-10"
        contextWindow={
          options?.contextWindow === undefined ? CONTEXT_WINDOW : options.contextWindow
        }
        contextProviderDisplayName="Claude"
        instanceEntries={options?.entries ?? ENTRIES}
        activeInstanceId={
          options?.entries ? options.entries[0]!.instanceId : ENTRIES[1]!.instanceId
        }
      />
      <div className="h-16 text-sm">Ask anything...</div>
    </div>,
    { container: host },
  );

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ComposerUsageMeter", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  it("floats inside the surface's top-right corner, clear of the rounded edge", async () => {
    ({ cleanup } = await mountMeter());

    const surface = document.querySelector<HTMLElement>('[data-testid="composer-surface"]')!;
    const trigger = document.querySelector<HTMLButtonElement>("button")!;
    const surfaceRect = surface.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();

    // Right-aligned and at the top…
    expect(surfaceRect.right - triggerRect.right).toBeGreaterThanOrEqual(2);
    expect(surfaceRect.right - triggerRect.right).toBeLessThanOrEqual(4);
    expect(triggerRect.top - surfaceRect.top).toBeGreaterThanOrEqual(2);
    // …and fully contained, so the 20px corner radius never clips it.
    expect(triggerRect.right).toBeLessThanOrEqual(surfaceRect.right);
    expect(triggerRect.bottom).toBeLessThanOrEqual(surfaceRect.bottom);
    // Absolute, so it takes no space from the row it floats over.
    expect(window.getComputedStyle(trigger).position).toBe("absolute");
  });

  it("shows the context window and every provider's plan usage in one popover", async () => {
    ({ cleanup } = await mountMeter());

    expect(document.querySelectorAll('[data-testid="concentric-usage-ring"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-usage-ring-layer="weekly"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-usage-ring-layer="session"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-usage-ring-layer="context"]')).toHaveLength(1);

    await page.getByRole("button").hover();
    await expect.element(page.getByText("Context window")).toBeVisible();

    const popup = page.getByText("Context window").element();
    const panel = popup.closest('[data-slot="popover-popup"]')!;
    const text = panel.textContent ?? "";

    expect(text).toContain("15k/200k");
    expect(text).toContain("Plan usage");
    // Both providers, active instance first.
    expect(text.indexOf("Codex")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Claude")).toBeGreaterThan(text.indexOf("Codex"));
    expect(text).toContain("Max 20x");
    expect(text).toContain("5-hour window");
  });

  it("projects the burn rate against the window's elapsed time", async () => {
    // 50% of a five-hour window burned in its first hour: the remaining half
    // lasts another hour, three short of the reset.
    ({ cleanup } = await mountMeter({
      entries: [instanceEntry("claudeAgent", "Claude", pacedUsage(50))],
    }));

    await page.getByRole("button").hover();
    await expect.element(page.getByText("Plan usage")).toBeVisible();

    const panel = page.getByText("Plan usage").element().closest('[data-slot="popover-popup"]')!;
    expect(panel.textContent ?? "").toContain("At this rate, you run out in 1h");
    // The pace tick marks where usage would sit if spread evenly (20% in).
    const tick = panel.querySelector<HTMLElement>('[data-usage-pace-tick="five_hour"]');
    expect(tick?.style.left).toBe("20%");
  });

  it("stays quiet about pace on a window that reports no width", async () => {
    ({ cleanup } = await mountMeter());

    await page.getByRole("button").hover();
    await expect.element(page.getByText("Plan usage")).toBeVisible();

    const panel = page.getByText("Plan usage").element().closest('[data-slot="popover-popup"]')!;
    expect(panel.textContent ?? "").not.toContain("On pace");
    expect(panel.querySelector("[data-usage-pace-tick]")).toBeNull();
  });

  it("still renders plan usage before the first context-window update", async () => {
    ({ cleanup } = await mountMeter({ contextWindow: null }));

    await page.getByRole("button").hover();
    await expect.element(page.getByText("Plan usage")).toBeVisible();

    const heading = page.getByText("Plan usage").element();
    const panel = heading.closest('[data-slot="popover-popup"]')!;
    expect(panel.textContent ?? "").not.toContain("Context window");
  });
});
