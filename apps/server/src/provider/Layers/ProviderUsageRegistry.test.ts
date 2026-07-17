import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsage,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { normalizeClaudeUsage } from "../ClaudeUsage.ts";
import {
  ProviderUsageRegistry,
  ProviderUsageRegistryLive,
  publishProviderSnapshotUsage,
} from "./ProviderUsageRegistry.ts";

const INSTANCE_ID = ProviderInstanceId.make("claude_default");
const OTHER_INSTANCE_ID = ProviderInstanceId.make("claude_work");
const PROBE_AT = "2026-07-17T09:00:00.000Z";
const EVENT_AT = "2026-07-17T09:30:00.000Z";

const claudeProbeUsage = (): ServerProviderUsage =>
  normalizeClaudeUsage({
    raw: {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 12, resets_at: "2026-07-17T11:10:00Z" },
        seven_day: { utilization: 40, resets_at: "2026-07-21T08:00:00Z" },
      },
    },
    capturedAt: PROBE_AT,
  })!;

const claudeEventUsage = (): ServerProviderUsage =>
  normalizeClaudeUsage({
    raw: {
      rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 82 },
    },
    capturedAt: EVENT_AT,
  })!;

const baseSnapshot = (usage?: ServerProviderUsage): ServerProvider => ({
  instanceId: INSTANCE_ID,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: PROBE_AT,
  models: [],
  slashCommands: [],
  skills: [],
  ...(usage ? { usage } : {}),
});

/**
 * Drive `publishProviderSnapshotUsage` the way a driver's `enrichSnapshot`
 * does — a live snapshot Ref behind an atomic `updateSnapshot` — so the wiring
 * is under test, not just `mergeProviderUsage` in isolation.
 */
const runEnrichment = (input: { readonly snapshot: ServerProvider }) =>
  Effect.gen(function* () {
    const registry = yield* ProviderUsageRegistry;
    const snapshotRef = yield* Ref.make(input.snapshot);
    // `publishProviderSnapshotUsage` never completes, mirroring the driver's
    // enrichment fiber. `forkChild` ties it to the test fiber's lifetime.
    const fiber = yield* publishProviderSnapshotUsage({
      registry,
      instanceId: INSTANCE_ID,
      snapshot: input.snapshot,
      updateSnapshot: (update) => Ref.update(snapshotRef, update),
    }).pipe(Effect.forkChild);
    // Let the seed land before the test pushes events at it.
    yield* Effect.yieldNow;
    return { registry, snapshotRef, fiber };
  });

describe("publishProviderSnapshotUsage", () => {
  it.effect("seeds the registry from the probe so a later event merges onto it", () =>
    Effect.gen(function* () {
      const { registry, snapshotRef } = yield* runEnrichment({
        snapshot: baseSnapshot(claudeProbeUsage()),
      });

      // The regression this guards: previously the probe reached the snapshot
      // but never the registry, so the first event's merge saw `previous ===
      // undefined` and replaced the probe's full window set with its one.
      yield* registry.publish({ instanceId: INSTANCE_ID, usage: claudeEventUsage() });
      yield* Effect.yieldNow;

      const snapshot = yield* Ref.get(snapshotRef);
      expect(snapshot.usage?.windows).toEqual([
        { id: "five_hour", label: "Session", percent: 82, resetsAt: null, severity: "warning" },
        // Must survive: the event said nothing about it.
        { id: "seven_day", label: "Weekly", percent: 40, resetsAt: "2026-07-21T08:00:00.000Z" },
      ]);
      // Only the probe carries the plan; an event must never blank it.
      expect(snapshot.usage?.planLabel).toBe("max");
    }).pipe(Effect.provide(ProviderUsageRegistryLive)),
  );

  it.effect("publishes the probe usage onto the snapshot even with no events", () =>
    Effect.gen(function* () {
      const { snapshotRef } = yield* runEnrichment({
        snapshot: baseSnapshot(claudeProbeUsage()),
      });

      const snapshot = yield* Ref.get(snapshotRef);
      expect(snapshot.usage?.planLabel).toBe("max");
      expect(snapshot.usage?.windows.map((window) => window.id)).toEqual([
        "five_hour",
        "seven_day",
      ]);
    }).pipe(Effect.provide(ProviderUsageRegistryLive)),
  );

  it.effect("carries event usage across a re-probe that reports no usage", () =>
    Effect.gen(function* () {
      // Generation 1: probe + event.
      const first = yield* runEnrichment({ snapshot: baseSnapshot(claudeProbeUsage()) });
      yield* first.registry.publish({ instanceId: INSTANCE_ID, usage: claudeEventUsage() });
      yield* Effect.yieldNow;

      // Generation 2 (the 5-minute refresh) restarts enrichment against a
      // fresh snapshot whose probe came back empty. Usage lives in the
      // registry precisely so it outlives the generation roll.
      const second = yield* runEnrichment({ snapshot: baseSnapshot() });

      const snapshot = yield* Ref.get(second.snapshotRef);
      expect(snapshot.usage?.planLabel).toBe("max");
      expect(snapshot.usage?.windows.map((window) => window.percent)).toEqual([82, 40]);
    }).pipe(Effect.provide(ProviderUsageRegistryLive)),
  );

  it.effect("lets a fresh probe refresh windows an old event had moved", () =>
    Effect.gen(function* () {
      const first = yield* runEnrichment({ snapshot: baseSnapshot(claudeProbeUsage()) });
      yield* first.registry.publish({ instanceId: INSTANCE_ID, usage: claudeEventUsage() });
      yield* Effect.yieldNow;

      // A later probe is a complete reading and must win for its own windows —
      // e.g. after the 5h window resets, five_hour drops back to 3%.
      const refreshed = normalizeClaudeUsage({
        raw: {
          subscription_type: "max",
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 3, resets_at: null },
            seven_day: { utilization: 41, resets_at: null },
          },
        },
        capturedAt: "2026-07-17T14:00:00.000Z",
      })!;
      const second = yield* runEnrichment({ snapshot: baseSnapshot(refreshed) });

      const snapshot = yield* Ref.get(second.snapshotRef);
      expect(snapshot.usage?.windows.map((window) => window.percent)).toEqual([3, 41]);
      expect(snapshot.usage?.source).toBe("probe");
    }).pipe(Effect.provide(ProviderUsageRegistryLive)),
  );

  it.effect("ignores updates published for a different instance", () =>
    Effect.gen(function* () {
      const { registry, snapshotRef } = yield* runEnrichment({
        snapshot: baseSnapshot(claudeProbeUsage()),
      });

      yield* registry.publish({ instanceId: OTHER_INSTANCE_ID, usage: claudeEventUsage() });
      yield* Effect.yieldNow;

      const snapshot = yield* Ref.get(snapshotRef);
      expect(snapshot.usage?.windows.map((window) => window.percent)).toEqual([12, 40]);
    }).pipe(Effect.provide(ProviderUsageRegistryLive)),
  );

  it.effect("leaves the snapshot untouched when nothing has reported usage", () =>
    Effect.gen(function* () {
      const { snapshotRef } = yield* runEnrichment({ snapshot: baseSnapshot() });

      const snapshot = yield* Ref.get(snapshotRef);
      expect(snapshot.usage).toBeUndefined();
    }).pipe(Effect.provide(ProviderUsageRegistryLive)),
  );
});

describe("ProviderUsageRegistry", () => {
  it.effect("keeps instances isolated", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderUsageRegistry;

      yield* registry.publish({ instanceId: INSTANCE_ID, usage: claudeProbeUsage() });
      yield* registry.publish({ instanceId: OTHER_INSTANCE_ID, usage: claudeEventUsage() });

      const first = yield* registry.get(INSTANCE_ID);
      const second = yield* registry.get(OTHER_INSTANCE_ID);
      expect(first?.windows.map((window) => window.percent)).toEqual([12, 40]);
      expect(second?.windows.map((window) => window.percent)).toEqual([82]);
    }).pipe(Effect.provide(ProviderUsageRegistryLive)),
  );

  it.effect("returns the merged value from publish", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderUsageRegistry;

      yield* registry.publish({ instanceId: INSTANCE_ID, usage: claudeProbeUsage() });
      const merged = yield* registry.publish({
        instanceId: INSTANCE_ID,
        usage: claudeEventUsage(),
      });

      expect(merged.planLabel).toBe("max");
      expect(merged.windows.map((window) => window.percent)).toEqual([82, 40]);
    }).pipe(Effect.provide(ProviderUsageRegistryLive)),
  );
});
