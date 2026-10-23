import {
  EventId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeLiveThoughtTracker } from "./liveThoughtTracker.ts";

const threadId = ThreadId.make("thread-1");
let eventCounter = 0;

function at(seconds: number): string {
  const millis = Math.round(seconds * 1000);
  return `2026-01-01T00:00:${String(Math.floor(millis / 1000)).padStart(2, "0")}.${String(millis % 1000).padStart(3, "0")}Z`;
}

function base(seconds: number, turn = "turn-1") {
  eventCounter += 1;
  return {
    eventId: EventId.make(`evt-${eventCounter}`),
    provider: ProviderDriverKind.make("claudeAgent"),
    threadId,
    createdAt: at(seconds),
    turnId: TurnId.make(turn),
  };
}

function reasoning(
  seconds: number,
  delta: string,
  options?: {
    summary?: boolean;
    itemId?: string;
    summaryIndex?: number;
    turn?: string;
  },
): ProviderRuntimeEvent {
  return {
    ...base(seconds, options?.turn),
    ...(options?.itemId ? { itemId: RuntimeItemId.make(options.itemId) } : {}),
    type: "content.delta",
    payload: {
      streamKind: options?.summary ? "reasoning_summary_text" : "reasoning_text",
      delta,
      ...(options?.summaryIndex !== undefined ? { summaryIndex: options.summaryIndex } : {}),
    },
  };
}

function toolStarted(seconds: number): ProviderRuntimeEvent {
  return {
    ...base(seconds),
    type: "item.started",
    payload: { itemType: "command_execution", status: "inProgress" },
  };
}

describe("liveThoughtTracker", () => {
  it("publishes the first sentence of the latest paragraph", () => {
    const tracker = makeLiveThoughtTracker();
    expect(tracker.observe(reasoning(0, "Reading the adapter. It looks fine."))).toEqual({
      threadId,
      liveThought: { turnId: "turn-1", text: "Reading the adapter.", updatedAt: at(0) },
    });
    expect(tracker.observe(reasoning(1, "\n\nNow checking the ingestion"))?.liveThought?.text).toBe(
      "Now checking the ingestion",
    );
  });

  it("keeps the last line while a new paragraph has no text yet", () => {
    const tracker = makeLiveThoughtTracker();
    tracker.observe(reasoning(0, "First idea."));
    expect(tracker.observe(reasoning(1, "\n\n"))).toBeUndefined();
    expect(tracker.current(threadId)?.text).toBe("First idea.");
  });

  it("throttles deltas and flushes the pending line when the agent moves on", () => {
    const tracker = makeLiveThoughtTracker({ throttleMs: 1_000 });
    expect(tracker.observe(reasoning(0, "Checking"))?.liveThought?.text).toBe("Checking");
    expect(tracker.observe(reasoning(0.1, " the cache."))).toBeUndefined();
    expect(tracker.observe(toolStarted(0.2))?.liveThought?.text).toBe("Checking the cache.");
  });

  it("hands the throttled remainder to flushPending when the stream goes quiet", () => {
    const tracker = makeLiveThoughtTracker({ throttleMs: 1_000 });
    tracker.observe(reasoning(0, "Checking"));
    expect(tracker.hasPending(threadId)).toBe(false);
    expect(tracker.observe(reasoning(0.1, " the cache."))).toBeUndefined();
    expect(tracker.hasPending(threadId)).toBe(true);
    expect(tracker.flushPending(threadId)).toEqual({
      threadId,
      liveThought: { turnId: "turn-1", text: "Checking the cache.", updatedAt: at(0.1) },
    });
    expect(tracker.hasPending(threadId)).toBe(false);
    expect(tracker.flushPending(threadId)).toBeUndefined();
  });

  it("sees a paragraph break split across deltas after a very long paragraph", () => {
    const tracker = makeLiveThoughtTracker({ throttleMs: 0 });
    tracker.observe(reasoning(0, `Long thought. ${"x".repeat(5_000)}`));
    tracker.observe(reasoning(1, "\n"));
    expect(tracker.observe(reasoning(2, "\nNext idea."))?.liveThought?.text).toBe("Next idea.");
  });

  it("does not republish an unchanged line", () => {
    const tracker = makeLiveThoughtTracker({ throttleMs: 0 });
    tracker.observe(reasoning(0, "Same thought. "));
    expect(tracker.observe(reasoning(1, "Then more detail."))).toBeUndefined();
  });

  it("prefers a summary over raw reasoning for the same item", () => {
    const tracker = makeLiveThoughtTracker({ throttleMs: 0 });
    tracker.observe(reasoning(0, "Raw musing.", { itemId: "rs-1" }));
    expect(
      tracker.observe(
        reasoning(1, "**Planning the fix**\n\nDetails.", {
          itemId: "rs-1",
          summary: true,
          summaryIndex: 0,
        }),
      )?.liveThought?.text,
    ).toBe("Planning the fix");
    expect(tracker.observe(reasoning(2, "\n\nMore raw musing.", { itemId: "rs-1" }))).toBe(
      undefined,
    );
    expect(
      tracker.observe(
        reasoning(3, "**Writing tests**", { itemId: "rs-1", summary: true, summaryIndex: 1 }),
      )?.liveThought?.text,
    ).toBe("Writing tests");
  });

  it("clears on turn end and ignores blank reasoning", () => {
    const tracker = makeLiveThoughtTracker();
    expect(tracker.observe(reasoning(0, "   "))).toBeUndefined();
    tracker.observe(reasoning(1, "Thinking hard."));
    expect(
      tracker.observe({
        ...base(2),
        type: "turn.completed",
        payload: { state: "completed" },
      }),
    ).toEqual({ threadId, liveThought: null });
    expect(tracker.current(threadId)).toBeNull();
  });

  it("ignores a late completion for another turn", () => {
    const tracker = makeLiveThoughtTracker();
    tracker.observe(reasoning(0, "Current turn thought.", { turn: "turn-2" }));
    expect(
      tracker.observe({
        ...base(1, "turn-1"),
        type: "turn.completed",
        payload: { state: "completed" },
      }),
    ).toBeUndefined();
    expect(tracker.current(threadId)?.text).toBe("Current turn thought.");
  });

  it("starts fresh for a new turn", () => {
    const tracker = makeLiveThoughtTracker();
    tracker.observe(reasoning(0, "Old turn thought."));
    expect(tracker.observe(reasoning(1, "New turn thought.", { turn: "turn-2" }))).toEqual({
      threadId,
      liveThought: { turnId: "turn-2", text: "New turn thought.", updatedAt: at(1) },
    });
  });
});
