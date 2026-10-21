/**
 * ClaudeCredentialStoreRegistry — which enabled Claude instance reads which
 * sign-in file, so an instance can be told when the answer is "not only me".
 *
 * A driver's `create` only ever sees its own settings, and the instance
 * registry is driver-agnostic and built around these very drivers, so neither
 * can answer "is anybody else reading my credentials file". This registry is
 * the seam: every enabled Claude instance registers itself for the lifetime of
 * its own child scope, and each snapshot probe asks what else it overlaps with.
 *
 * Entries hold a *resolver*, not a resolved path. The sharing this guards
 * against is usually introduced from outside the app — a symlink written by a
 * shell script, a config dir pointed at Claude Desktop's folder — long after
 * the instance was built, so the paths are re-read on every probe rather than
 * frozen at registration. Three instances resolving two paths each, once every
 * five minutes, costs nothing worth saving.
 *
 * @module provider/Layers/ClaudeCredentialStoreRegistry
 */
import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import {
  findClaudeCredentialSharing,
  type ClaudeCredentialSharing,
  type ClaudeCredentialStoreClaim,
  type ClaudeCredentialStoreLocation,
} from "../Drivers/ClaudeCredentialSharing.ts";

export interface ClaudeCredentialStoreEntry {
  readonly instanceId: ProviderInstanceId;
  /** What to call this instance when naming it in another instance's warning. */
  readonly label: string;
  /** Re-reads this instance's resolved paths. Run on every lookup. */
  readonly locate: Effect.Effect<ClaudeCredentialStoreLocation>;
}

export interface ClaudeCredentialStoreRegistryShape {
  /**
   * Hold this instance's entry for the lifetime of the calling scope. The
   * instance scope is closed whenever settings replace or remove the instance,
   * so a removed instance stops being named in its siblings' warnings without
   * anything having to deregister it explicitly.
   */
  readonly register: (entry: ClaudeCredentialStoreEntry) => Effect.Effect<void, never, Scope.Scope>;

  /**
   * What this instance shares its sign-in with right now, or `undefined` when
   * the sign-in is its own. An unregistered id — a disabled instance, or one
   * torn down mid-probe — shares nothing.
   */
  readonly sharingFor: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ClaudeCredentialSharing | undefined>;
}

export class ClaudeCredentialStoreRegistry extends Context.Service<
  ClaudeCredentialStoreRegistry,
  ClaudeCredentialStoreRegistryShape
>()("t3/provider/Layers/ClaudeCredentialStoreRegistry") {}

export const ClaudeCredentialStoreRegistryLive = Layer.effect(
  ClaudeCredentialStoreRegistry,
  Effect.gen(function* () {
    const entries = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ClaudeCredentialStoreEntry>>(
      new Map(),
    );

    const register: ClaudeCredentialStoreRegistryShape["register"] = (entry) =>
      Effect.acquireRelease(
        Ref.update(entries, (current) => new Map(current).set(entry.instanceId, entry)),
        () =>
          Ref.update(entries, (current) => {
            const next = new Map(current);
            // Only drop the entry if it is still ours: a replaced instance
            // registers its successor before the old scope's finalizer runs.
            if (next.get(entry.instanceId) === entry) next.delete(entry.instanceId);
            return next;
          }),
      ).pipe(Effect.asVoid);

    const sharingFor: ClaudeCredentialStoreRegistryShape["sharingFor"] = (instanceId) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(entries);
        if (!current.has(instanceId)) return undefined;

        const claims = yield* Effect.forEach(
          [...current.values()],
          (entry) =>
            entry.locate.pipe(
              Effect.map(
                (location): ClaudeCredentialStoreClaim => ({
                  ...location,
                  instanceId: entry.instanceId,
                  label: entry.label,
                }),
              ),
            ),
          { concurrency: "unbounded" },
        );

        const claim = claims.find((candidate) => candidate.instanceId === instanceId);
        if (!claim) return undefined;
        return findClaudeCredentialSharing({ claim, others: claims });
      });

    return { register, sharingFor } satisfies ClaudeCredentialStoreRegistryShape;
  }),
);

/**
 * Inert registry for tests and boot paths that never run a Claude session.
 * Keeps the tag non-optional in the type system while reporting no sharing.
 */
export const NoOpClaudeCredentialStoreRegistryLive = Layer.succeed(ClaudeCredentialStoreRegistry, {
  register: () => Effect.void,
  sharingFor: () => Effect.sync(() => undefined),
} satisfies ClaudeCredentialStoreRegistryShape);
