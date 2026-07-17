/**
 * ProviderUsageRegistry — live plan-usage state, keyed by provider instance.
 *
 * Bridges two layers that cannot see each other directly:
 *
 *  - **Writer**: `ProviderRuntimeIngestion` observes the canonical
 *    `account.rate-limits.updated` runtime event. It is the only place that
 *    sees every provider's usage pushes with an `instanceId` already attached,
 *    so it owns normalization.
 *  - **Readers**: each driver's `makeManagedServerProvider.enrichSnapshot`,
 *    which republishes its `ServerProvider` snapshot with fresh `usage`.
 *
 * Why a registry rather than a Ref inside each driver: `enrichSnapshot` fibers
 * are interrupted and restarted on every snapshot generation (a re-check every
 * 5 minutes, plus any settings change). Usage has to outlive those
 * generations, so it lives here — owned by the runtime layer, not by any
 * single enrichment fiber. `publish` merges through `mergeProviderUsage`, so
 * the sparse pushes both providers emit accumulate instead of clobbering.
 *
 * @module provider/Layers/ProviderUsageRegistry
 */
import type { ProviderInstanceId, ServerProvider, ServerProviderUsage } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { mergeProviderUsage } from "../providerUsage.ts";

export interface ProviderUsageUpdate {
  readonly instanceId: ProviderInstanceId;
  readonly usage: ServerProviderUsage;
}

export interface ProviderUsageRegistryShape {
  /**
   * Merge a usage observation into the instance's current usage and notify
   * subscribers with the merged result.
   *
   * Merging (not replacing) is the contract here — see `mergeProviderUsage`.
   * A no-op merge still publishes; snapshot de-duplication happens downstream
   * in `makeManagedServerProvider.publishEnrichedSnapshot`, which compares by
   * value before touching the PubSub.
   */
  readonly publish: (input: ProviderUsageUpdate) => Effect.Effect<ServerProviderUsage>;

  /** Latest merged usage, or `undefined` if none has been observed. */
  readonly get: (instanceId: ProviderInstanceId) => Effect.Effect<ServerProviderUsage | undefined>;

  /**
   * Merged usage updates for one instance.
   *
   * Does not replay the current value — callers that need it read `get`
   * first, which is what `enrichSnapshot` does on each generation restart.
   */
  readonly changes: (instanceId: ProviderInstanceId) => Stream.Stream<ServerProviderUsage>;
}

/**
 * ProviderUsageRegistry — service tag for live provider plan usage.
 */
export class ProviderUsageRegistry extends Context.Service<
  ProviderUsageRegistry,
  ProviderUsageRegistryShape
>()("t3/provider/Layers/ProviderUsageRegistry") {}

/**
 * In-memory registry. Usage is deliberately process-local and never
 * persisted: `writeProviderStatusCache` strips it, because a rate-limit
 * percentage restored from disk describes a window that has almost certainly
 * already reset.
 */
export const ProviderUsageRegistryLive = Layer.effect(
  ProviderUsageRegistry,
  Effect.gen(function* () {
    const usageByInstance = yield* Ref.make(new Map<ProviderInstanceId, ServerProviderUsage>());
    const updates = yield* Effect.acquireRelease(
      PubSub.unbounded<ProviderUsageUpdate>(),
      PubSub.shutdown,
    );

    const publish: ProviderUsageRegistryShape["publish"] = (input) =>
      Effect.gen(function* () {
        const merged = yield* Ref.modify(usageByInstance, (current) => {
          const next = mergeProviderUsage(current.get(input.instanceId), input.usage);
          const updated = new Map(current);
          updated.set(input.instanceId, next);
          return [next, updated] as const;
        });
        yield* PubSub.publish(updates, { instanceId: input.instanceId, usage: merged });
        return merged;
      });

    return {
      publish,
      get: (instanceId) =>
        Ref.get(usageByInstance).pipe(Effect.map((current) => current.get(instanceId))),
      changes: (instanceId) =>
        Stream.fromPubSub(updates).pipe(
          Stream.filter((update) => update.instanceId === instanceId),
          Stream.map((update) => update.usage),
        ),
    } satisfies ProviderUsageRegistryShape;
  }),
);

/**
 * Inert registry for tests and boot paths that don't run provider sessions.
 * Keeps the tag non-optional in the type system while making usage a no-op.
 */
export const NoOpProviderUsageRegistryLive = Layer.succeed(ProviderUsageRegistry, {
  publish: (input) => Effect.succeed(input.usage),
  get: () => Effect.sync(() => undefined),
  changes: () => Stream.never,
} satisfies ProviderUsageRegistryShape);

/**
 * Keep a provider snapshot's `usage` in sync with the registry.
 *
 * Intended as (part of) a driver's `makeManagedServerProvider.enrichSnapshot`.
 * Seeds from the registry's current value — the snapshot generation that just
 * restarted this fiber dropped whatever usage the previous one published —
 * then republishes on every subsequent update. Never completes; the managed
 * provider interrupts it when the generation rolls.
 *
 * Takes the registry as a value rather than through `R` because
 * `enrichSnapshot`'s signature pins `R = never`.
 *
 * Each publish rebases on `getSnapshot` rather than a captured snapshot, so
 * it composes with concurrent enrichments (e.g. the version advisory) instead
 * of racing them and dropping whichever landed first.
 */
export const publishProviderSnapshotUsage = (input: {
  readonly registry: ProviderUsageRegistryShape;
  readonly instanceId: ProviderInstanceId;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<void> => {
  const republish = (usage: ServerProviderUsage) =>
    input.getSnapshot.pipe(
      Effect.flatMap((snapshot) => input.publishSnapshot({ ...snapshot, usage })),
    );

  return Effect.gen(function* () {
    const seed = yield* input.registry.get(input.instanceId);
    if (seed) {
      yield* republish(seed);
    }
    yield* Stream.runForEach(input.registry.changes(input.instanceId), republish);
  });
};
