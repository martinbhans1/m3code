import {
  EventId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeThreadLiveThoughts } from "./ThreadLiveThoughts.ts";

const threadId = ThreadId.make("thread-1");

function reasoning(id: string, createdAt: string, delta: string): ProviderRuntimeEvent {
  return {
    eventId: EventId.make(id),
    provider: ProviderDriverKind.make("claudeAgent"),
    threadId,
    turnId: TurnId.make("turn-1"),
    createdAt,
    type: "content.delta",
    payload: { streamKind: "reasoning_text", delta },
  };
}

it.effect("publishes the throttled remainder once the reasoning stream goes quiet", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const liveThoughts = yield* makeThreadLiveThoughts({ throttleMs: 300 });
      const subscription = yield* liveThoughts.subscribe(threadId);
      const received = yield* subscription.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* liveThoughts.observe(reasoning("evt-1", "2026-01-01T00:00:00.000Z", "Checking"));
      yield* liveThoughts.observe(
        reasoning("evt-2", "2026-01-01T00:00:00.100Z", " the cache. More."),
      );
      expect((yield* liveThoughts.get(threadId))?.text).toBe("Checking");

      yield* TestClock.adjust(Duration.millis(300));
      expect((yield* liveThoughts.get(threadId))?.text).toBe("Checking the cache.");
      const texts = Array.from(yield* Fiber.join(received)).map((thought) => thought?.text);
      expect(texts).toEqual(["Checking", "Checking the cache."]);
    }),
  ),
);

it.effect("reports the thought already live when a subscriber joins", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const liveThoughts = yield* makeThreadLiveThoughts({ throttleMs: 0 });
      yield* liveThoughts.observe(reasoning("evt-1", "2026-01-01T00:00:00.000Z", "Reading."));
      const subscription = yield* liveThoughts.subscribe(threadId);
      expect(subscription.current?.text).toBe("Reading.");
    }),
  ),
);
