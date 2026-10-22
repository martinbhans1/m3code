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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { makeLiveThoughtTracker, type LiveThoughtUpdate } from "../liveThoughtTracker.ts";

export interface ThreadLiveThoughtsShape {
  /** Feed one runtime event for a thread the server knows about. */
  readonly observe: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  /** Latest thought for a thread, or `null` when none is live. */
  readonly get: (threadId: ThreadId) => Effect.Effect<OrchestrationThreadLiveThought | null>;
  /** Changes for one thread; `null` clears. Does not replay the current value. */
  readonly changes: (threadId: ThreadId) => Stream.Stream<OrchestrationThreadLiveThought | null>;
}

export class ThreadLiveThoughts extends Context.Service<
  ThreadLiveThoughts,
  ThreadLiveThoughtsShape
>()("t3/orchestration/Layers/ThreadLiveThoughts") {}

export const ThreadLiveThoughtsLive = Layer.effect(
  ThreadLiveThoughts,
  Effect.gen(function* () {
    const tracker = makeLiveThoughtTracker();
    const updates = yield* Effect.acquireRelease(
      PubSub.unbounded<LiveThoughtUpdate>(),
      PubSub.shutdown,
    );

    return {
      observe: (event) =>
        Effect.suspend(() => {
          const update = tracker.observe(event);
          return update ? PubSub.publish(updates, update).pipe(Effect.asVoid) : Effect.void;
        }),
      get: (threadId) => Effect.sync(() => tracker.current(threadId)),
      changes: (threadId) =>
        Stream.fromPubSub(updates).pipe(
          Stream.filter((update) => update.threadId === threadId),
          Stream.map((update) => update.liveThought),
        ),
    } satisfies ThreadLiveThoughtsShape;
  }),
);
