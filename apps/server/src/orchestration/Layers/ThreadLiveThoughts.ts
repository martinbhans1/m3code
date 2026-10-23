/**
 * ThreadLiveThoughts — the agent's latest thought per thread, live only.
 *
 * - **Writer**: `ProviderRuntimeIngestion` feeds every runtime event of a
 *   known thread through the pure `liveThoughtTracker`.
 * - **Reader**: the `subscribeThread` RPC, for clients that opt in, forwards
 *   the current thought after the snapshot and every change after that.
 *
 * Deliberately outside the event store: a thought is overwritten many times a
 * turn and worthless once the turn ends, so persisting it would only grow the
 * database and replay cost for something no one reads twice.
 *
 * @module orchestration/Layers/ThreadLiveThoughts
 */
import type {
  OrchestrationThreadLiveThought,
  ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  LIVE_THOUGHT_THROTTLE_MS,
  makeLiveThoughtTracker,
  type LiveThoughtUpdate,
} from "../liveThoughtTracker.ts";

export interface ThreadLiveThoughtSubscription {
  /** The thought live when the subscription opened, or `null`. */
  readonly current: OrchestrationThreadLiveThought | null;
  /** Every later change; `null` clears. */
  readonly changes: Stream.Stream<OrchestrationThreadLiveThought | null>;
}

export interface ThreadLiveThoughtsShape {
  /** Feed one runtime event for a thread the server knows about. */
  readonly observe: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  /** Latest thought for a thread, or `null` when none is live. */
  readonly get: (threadId: ThreadId) => Effect.Effect<OrchestrationThreadLiveThought | null>;
  /**
   * Current thought plus later changes for one thread. Subscribes before it
   * reads, so a change racing the read arrives (at worst twice), never lost.
   */
  readonly subscribe: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadLiveThoughtSubscription, never, Scope.Scope>;
}

export class ThreadLiveThoughts extends Context.Service<
  ThreadLiveThoughts,
  ThreadLiveThoughtsShape
>()("t3/orchestration/Layers/ThreadLiveThoughts") {}

export const makeThreadLiveThoughts = (options?: { readonly throttleMs?: number }) =>
  Effect.gen(function* () {
    const throttleMs = options?.throttleMs ?? LIVE_THOUGHT_THROTTLE_MS;
    const tracker = makeLiveThoughtTracker({ throttleMs });
    const updates = yield* Effect.acquireRelease(
      PubSub.unbounded<LiveThoughtUpdate>(),
      PubSub.shutdown,
    );
    // One trailing-edge timer per thread at most; interrupted with the layer.
    const trailingFlushes = yield* FiberMap.make<ThreadId>();

    // Derive and publish in one synchronous step, so a timer's flush and the
    // ingestion worker's clear can never publish out of order.
    const publishNow = (update: LiveThoughtUpdate | undefined) => {
      if (update) PubSub.publishUnsafe(updates, update);
    };

    const flushLater = (threadId: ThreadId) =>
      FiberMap.run(
        trailingFlushes,
        threadId,
        Effect.sleep(Duration.millis(throttleMs)).pipe(
          Effect.andThen(Effect.sync(() => publishNow(tracker.flushPending(threadId)))),
        ),
        { onlyIfMissing: true },
      );

    return {
      observe: (event) =>
        Effect.suspend(() => {
          publishNow(tracker.observe(event));
          return tracker.hasPending(event.threadId)
            ? flushLater(event.threadId).pipe(Effect.asVoid)
            : Effect.void;
        }),
      get: (threadId) => Effect.sync(() => tracker.current(threadId)),
      subscribe: (threadId) =>
        PubSub.subscribe(updates).pipe(
          Effect.map((subscription) => ({
            current: tracker.current(threadId),
            changes: Stream.fromSubscription(subscription).pipe(
              Stream.filter((update) => update.threadId === threadId),
              Stream.map((update) => update.liveThought),
            ),
          })),
        ),
    } satisfies ThreadLiveThoughtsShape;
  });

export const ThreadLiveThoughtsLive = Layer.effect(ThreadLiveThoughts, makeThreadLiveThoughts());
