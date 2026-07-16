import { beforeEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime";
import { useQueuedTurnStore, type QueuedTurn } from "./queuedTurnStore";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("thread-1"));

function turn(id: string): QueuedTurn {
  return {
    id,
    threadRef,
    displayText: id,
    status: "queued",
    error: null,
    command: {
      type: "thread.turn.start",
      commandId: `command-${id}` as never,
      threadId: threadRef.threadId,
      message: { messageId: `message-${id}` as never, role: "user", text: id, attachments: [] },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: "2026-07-15T00:00:00.000Z" as never,
    },
  };
}

describe("queuedTurnStore", () => {
  beforeEach(() => useQueuedTurnStore.setState({ byThreadKey: {} }));

  it("queues and reorders messages per thread", () => {
    const store = useQueuedTurnStore.getState();
    store.enqueue(turn("first"));
    store.enqueue(turn("second"));
    useQueuedTurnStore.getState().move(threadRef, "second", -1);
    expect(
      useQueuedTurnStore.getState().byThreadKey[scopedThreadKey(threadRef)]?.map((x) => x.id),
    ).toEqual(["second", "first"]);
  });

  it("keeps failed messages until they are retried or removed", () => {
    useQueuedTurnStore.getState().enqueue(turn("first"));
    useQueuedTurnStore.getState().markFailed(threadRef, "first", "offline");
    expect(
      useQueuedTurnStore.getState().byThreadKey[scopedThreadKey(threadRef)]?.[0],
    ).toMatchObject({
      status: "failed",
      error: "offline",
    });
    useQueuedTurnStore.getState().retry(threadRef, "first");
    expect(
      useQueuedTurnStore.getState().byThreadKey[scopedThreadKey(threadRef)]?.[0],
    ).toMatchObject({
      status: "queued",
      error: null,
    });
  });
});
