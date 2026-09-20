import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime";

import {
  QUEUED_TURN_DISPATCH_GRACE_MS,
  isThreadAcceptingQueuedTurn,
  selectQueuedTurnsToDispatch,
  type QueuedTurnDispatchGuard,
  type QueuedTurnDrainCandidate,
} from "./queuedTurnDrain";
import type { QueuedTurn } from "./queuedTurnStore";

const NOW = Date.parse("2026-09-20T12:00:00.000Z");

function threadRefFor(id: string) {
  return scopeThreadRef(EnvironmentId.make("local"), ThreadId.make(id));
}

function queuedTurn(threadId: string): QueuedTurn {
  const threadRef = threadRefFor(threadId);
  return {
    id: `turn-${threadId}`,
    threadRef,
    displayText: "hello",
    status: "queued",
    error: null,
    command: {
      type: "thread.turn.start",
      commandId: `command-${threadId}` as never,
      threadId: threadRef.threadId,
      message: {
        messageId: `message-${threadId}` as never,
        role: "user",
        text: "hello",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: "2026-09-20T11:59:00.000Z" as never,
    },
  };
}

function candidate(
  threadId: string,
  overrides: Partial<QueuedTurnDrainCandidate> = {},
): QueuedTurnDrainCandidate {
  const turn = queuedTurn(threadId);
  return {
    key: scopedThreadKey(turn.threadRef),
    turn,
    sessionStatus: "ready",
    latestTurnState: "completed",
    threadArchived: false,
    transportConnected: true,
    ...overrides,
  };
}

function dispatchedKeys(
  candidates: ReadonlyArray<QueuedTurnDrainCandidate>,
  guards: ReadonlyMap<string, QueuedTurnDispatchGuard> = new Map(),
  now: number = NOW,
): ReadonlyArray<string> {
  return selectQueuedTurnsToDispatch({ candidates, guards, now }).map((entry) => entry.key);
}

describe("isThreadAcceptingQueuedTurn", () => {
  it("holds a queued turn while the agent is mid-turn", () => {
    expect(
      isThreadAcceptingQueuedTurn({ sessionStatus: "running", latestTurnState: "running" }),
    ).toBe(false);
    expect(
      isThreadAcceptingQueuedTurn({ sessionStatus: "starting", latestTurnState: "completed" }),
    ).toBe(false);
    expect(
      isThreadAcceptingQueuedTurn({ sessionStatus: "ready", latestTurnState: "running" }),
    ).toBe(false);
  });

  it("sends into a conversation whose provider session was reaped", () => {
    // The session being closed is not the same as the thread being busy: this
    // is the state every conversation lands in after half an hour idle, and it
    // used to park queued messages permanently.
    expect(
      isThreadAcceptingQueuedTurn({ sessionStatus: "stopped", latestTurnState: "completed" }),
    ).toBe(true);
    expect(isThreadAcceptingQueuedTurn({ sessionStatus: "idle", latestTurnState: null })).toBe(
      true,
    );
    expect(isThreadAcceptingQueuedTurn({ sessionStatus: null, latestTurnState: null })).toBe(true);
    expect(isThreadAcceptingQueuedTurn({ sessionStatus: "error", latestTurnState: "error" })).toBe(
      true,
    );
  });
});

describe("selectQueuedTurnsToDispatch", () => {
  it("drains every idle conversation, not just one", () => {
    expect(dispatchedKeys([candidate("a"), candidate("b")])).toEqual([
      scopedThreadKey(threadRefFor("a")),
      scopedThreadKey(threadRefFor("b")),
    ]);
  });

  it("skips threads that are busy, archived, offline, or already sending", () => {
    const busy = candidate("busy", { sessionStatus: "running" });
    const archived = candidate("archived", { threadArchived: true });
    const offline = candidate("offline", { transportConnected: false });
    const sending = candidate("sending");
    expect(
      dispatchedKeys([
        busy,
        archived,
        offline,
        { ...sending, turn: { ...sending.turn, status: "sending" } },
      ]),
    ).toEqual([]);
  });

  it("leaves a failed head alone so the user can retry it", () => {
    const failed = candidate("failed");
    expect(
      dispatchedKeys([{ ...failed, turn: { ...failed.turn, status: "failed", error: "nope" } }]),
    ).toEqual([]);
  });

  it("waits out the grace window after a dispatch, then stops waiting", () => {
    const entry = candidate("a");
    const guards = new Map<string, QueuedTurnDispatchGuard>([
      [entry.key, { kind: "dispatched", at: NOW }],
    ]);
    expect(dispatchedKeys([entry], guards, NOW + QUEUED_TURN_DISPATCH_GRACE_MS - 1)).toEqual([]);
    // The recovery that matters: a missed "running" projection must not wedge
    // the queue forever the way the old phase-watching guard did.
    expect(dispatchedKeys([entry], guards, NOW + QUEUED_TURN_DISPATCH_GRACE_MS + 1)).toEqual([
      entry.key,
    ]);
  });

  it("never dispatches twice while a send is in flight", () => {
    const entry = candidate("a");
    const guards = new Map<string, QueuedTurnDispatchGuard>([[entry.key, { kind: "in-flight" }]]);
    expect(dispatchedKeys([entry], guards, NOW + 10 * QUEUED_TURN_DISPATCH_GRACE_MS)).toEqual([]);
  });
});
