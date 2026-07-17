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
   * subscribers with the merged result. Returns the merged value.
   *
   * Merging (not replacing) is the contract here — see `mergeProviderUsage`.
   * Called both with probe readings (seeding the baseline) and with sparse
   * event updates (merging onto it).
   *
   * A no-op merge still publishes and still reaches subscribers: the snapshot
   * dedup in `makeManagedServerProvider` compares with `Equal.equals`, which
   * falls back to reference equality on plain objects, so a rebuilt
   * `{ ...current, usage }` never compares equal. Providers emit these at
   * human timescales, so the redundant republish is not worth guarding.
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
 * Never completes; the managed provider interrupts it when the generation
 * rolls.
 *
 * Takes the registry as a value rather than through `R` because
 * `enrichSnapshot`'s signature pins `R = never`.
 *
 * ## Seeding
 *
 * `snapshot.usage` is this generation's *probe* reading (Claude's SDK usage
 * call, Codex's `account/rateLimits/read`) — a complete picture of every
 * window. It is published into the registry rather than merely left on the
 * snapshot, because the registry is what sparse events merge against: without
 * this, `mergeProviderUsage`'s `previous` would always be `undefined` on the
 * first event, and a Claude `rate_limit_event` naming one window would replace
 * the probe's full set (and blank `planLabel`, which only the probe carries).
 *
 * Writes go through `updateSnapshot` so the usage field composes with the
 * concurrent version-advisory enrichment instead of racing it.
 */
export const publishProviderSnapshotUsage = (input: {
  readonly registry: ProviderUsageRegistryShape;
  readonly instanceId: ProviderInstanceId;
  readonly snapshot: ServerProvider;
  readonly updateSnapshot: (
    update: (current: ServerProvider) => ServerProvider,
  ) => Effect.Effect<void>;
}): Effect.Effect<void> => {
  const republish = (usage: ServerProviderUsage) =>
    input.updateSnapshot((current) => ({ ...current, usage }));

  return Effect.gen(function* () {
    // Merge (not overwrite) the probe in: a window the probe doesn't report
    // but a previous event did should survive, and across the 5-minute
    // re-probe the registry already holds event updates newer than the last
    // probe.
    const seed = input.snapshot.usage
      ? yield* input.registry.publish({
          instanceId: input.instanceId,
          usage: input.snapshot.usage,
        })
      : yield* input.registry.get(input.instanceId);

    if (seed) {
      yield* republish(seed);
    }
    yield* Stream.runForEach(input.registry.changes(input.instanceId), republish);
  });
};

/**
 * `enrichSnapshot` for the two drivers that report plan usage (Claude, Codex):
 * version advisory + live usage, running concurrently.
 *
 * Shared because both drivers need exactly this pair and the composition has
 * enough sharp edges (atomic `updateSnapshot` writes, usage seeding, failure
 * isolation between the two legs) that two copies would drift.
 *
 * The advisory leg is one-shot; the usage leg never completes. `discard` keeps
 * the combined effect `Effect<void>` as `enrichSnapshot` requires.
 */
export const enrichProviderSnapshotWithAdvisoryAndUsage = (input: {
  readonly snapshot: ServerProvider;
  readonly updateSnapshot: (
    update: (current: ServerProvider) => ServerProvider,
  ) => Effect.Effect<void>;
  readonly resolveVersionAdvisory: (
    snapshot: ServerProvider,
  ) => Effect.Effect<ServerProvider["versionAdvisory"]>;
  readonly registry: ProviderUsageRegistryShape;
  readonly instanceId: ProviderInstanceId;
}): Effect.Effect<void> =>
  Effect.all(
    [
      input
        .resolveVersionAdvisory(input.snapshot)
        .pipe(
          Effect.flatMap((versionAdvisory) =>
            versionAdvisory === undefined
              ? Effect.void
              : input.updateSnapshot((current) => ({ ...current, versionAdvisory })),
          ),
        ),
      publishProviderSnapshotUsage({
        registry: input.registry,
        instanceId: input.instanceId,
        snapshot: input.snapshot,
        updateSnapshot: input.updateSnapshot,
      }),
    ],
    { concurrency: "unbounded", discard: true },
  );
