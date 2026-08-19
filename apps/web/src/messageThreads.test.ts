import { describe, expect, it } from "vite-plus/test";
import { MessageId, TurnId } from "@t3tools/contracts";
import type { TimelineEntry } from "./session-logic";
import {
  anchorForActiveTurn,
  partitionMessageThreads,
  summarizeAnchorText,
} from "./messageThreads";

function userMessage(id: string, createdAt: string, replyToMessageId?: string): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.make(id),
      role: "user",
      text: `user ${id}`,
      turnId: null,
      ...(replyToMessageId !== undefined
        ? { replyToMessageId: MessageId.make(replyToMessageId) }
        : {}),
      createdAt,
      streaming: false,
    },
  };
}

function assistantMessage(
  id: string,
  createdAt: string,
  turnId: string,
  streaming = false,
): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.make(id),
      role: "assistant",
      text: `assistant ${id}`,
      turnId: TurnId.make(turnId),
      createdAt,
      streaming,
    },
  };
}

function workEntry(id: string, createdAt: string, turnId: string): TimelineEntry {
  return {
    id,
    kind: "work",
    createdAt,
    entry: {
      id,
      createdAt,
      turnId: TurnId.make(turnId),
      label: `work ${id}`,
      tone: "tool",
    },
  };
}

describe("partitionMessageThreads", () => {
  it("leaves a conversation with no anchored replies untouched", () => {
    const entries = [
      userMessage("u1", "2026-08-19T10:00:00.000Z"),
      assistantMessage("a1", "2026-08-19T10:00:01.000Z", "turn-1"),
    ];
    const partition = partitionMessageThreads(entries);
    expect(partition.mainEntries).toEqual(entries);
    expect(partition.threadsByAnchorId.size).toBe(0);
  });

  it("files an anchored reply and everything its turn produced under the anchor", () => {
    const entries = [
      userMessage("u1", "2026-08-19T10:00:00.000Z"),
      assistantMessage("a1", "2026-08-19T10:00:01.000Z", "turn-1"),
      userMessage("u2", "2026-08-19T10:01:00.000Z", "a1"),
      workEntry("w1", "2026-08-19T10:01:01.000Z", "turn-2"),
      assistantMessage("a2", "2026-08-19T10:01:02.000Z", "turn-2"),
    ];
    const partition = partitionMessageThreads(entries);

    expect(partition.mainEntries.map((entry) => entry.id)).toEqual(["u1", "a1"]);
    const thread = partition.threadsByAnchorId.get(MessageId.make("a1"));
    expect(thread?.entries.map((entry) => entry.id)).toEqual(["u2", "w1", "a2"]);
    expect(thread?.replyCount).toBe(1);
    expect(thread?.lastActivityAt).toBe("2026-08-19T10:01:02.000Z");
    expect(partition.anchorByTurnId.get(TurnId.make("turn-2"))).toBe(MessageId.make("a1"));
  });

  it("keeps a later main message out of the side thread", () => {
    const entries = [
      userMessage("u1", "2026-08-19T10:00:00.000Z"),
      assistantMessage("a1", "2026-08-19T10:00:01.000Z", "turn-1"),
      userMessage("u2", "2026-08-19T10:01:00.000Z", "a1"),
      assistantMessage("a2", "2026-08-19T10:01:02.000Z", "turn-2"),
      userMessage("u3", "2026-08-19T10:02:00.000Z"),
      assistantMessage("a3", "2026-08-19T10:02:02.000Z", "turn-3"),
    ];
    const partition = partitionMessageThreads(entries);

    expect(partition.mainEntries.map((entry) => entry.id)).toEqual(["u1", "a1", "u3", "a3"]);
    expect(
      partition.threadsByAnchorId.get(MessageId.make("a1"))?.entries.map((entry) => entry.id),
    ).toEqual(["u2", "a2"]);
  });

  it("keeps a late entry with the rest of its turn rather than the open thread", () => {
    const entries = [
      userMessage("u1", "2026-08-19T10:00:00.000Z"),
      assistantMessage("a1", "2026-08-19T10:00:01.000Z", "turn-1"),
      userMessage("u2", "2026-08-19T10:01:00.000Z", "a1"),
      assistantMessage("a2", "2026-08-19T10:01:02.000Z", "turn-2"),
      userMessage("u3", "2026-08-19T10:02:00.000Z"),
      // A tool row from the threaded turn that only reached the client now.
      workEntry("w-late", "2026-08-19T10:02:01.000Z", "turn-2"),
    ];
    const partition = partitionMessageThreads(entries);

    expect(partition.mainEntries.map((entry) => entry.id)).toEqual(["u1", "a1", "u3"]);
    expect(
      partition.threadsByAnchorId.get(MessageId.make("a1"))?.entries.map((entry) => entry.id),
    ).toEqual(["u2", "a2", "w-late"]);
  });

  it("supports several side threads at once", () => {
    const entries = [
      userMessage("u1", "2026-08-19T10:00:00.000Z"),
      assistantMessage("a1", "2026-08-19T10:00:01.000Z", "turn-1"),
      userMessage("u2", "2026-08-19T10:01:00.000Z", "a1"),
      assistantMessage("a2", "2026-08-19T10:01:02.000Z", "turn-2"),
      userMessage("u3", "2026-08-19T10:02:00.000Z", "u1"),
      assistantMessage("a3", "2026-08-19T10:02:02.000Z", "turn-3"),
    ];
    const partition = partitionMessageThreads(entries);

    expect(partition.mainEntries.map((entry) => entry.id)).toEqual(["u1", "a1"]);
    expect(partition.threadsByAnchorId.size).toBe(2);
    expect(
      partition.threadsByAnchorId.get(MessageId.make("u1"))?.entries.map((entry) => entry.id),
    ).toEqual(["u3", "a3"]);
  });

  it("leaves a reply in place when its anchor is no longer loaded", () => {
    const entries = [
      userMessage("u2", "2026-08-19T10:01:00.000Z", "trimmed-away"),
      assistantMessage("a2", "2026-08-19T10:01:02.000Z", "turn-2"),
    ];
    const partition = partitionMessageThreads(entries);
    expect(partition.mainEntries.map((entry) => entry.id)).toEqual(["u2", "a2"]);
    expect(partition.threadsByAnchorId.size).toBe(0);
  });

  it("reports a streaming side thread", () => {
    const entries = [
      assistantMessage("a1", "2026-08-19T10:00:01.000Z", "turn-1"),
      userMessage("u2", "2026-08-19T10:01:00.000Z", "a1"),
      assistantMessage("a2", "2026-08-19T10:01:02.000Z", "turn-2", true),
    ];
    const partition = partitionMessageThreads(entries);
    expect(partition.threadsByAnchorId.get(MessageId.make("a1"))?.streaming).toBe(true);
  });
});

describe("summarizeAnchorText", () => {
  it("collapses whitespace and drops fenced code", () => {
    expect(summarizeAnchorText("Here is\n\nsome  text\n```\ncode\n```\nafter")).toBe(
      "Here is some text after",
    );
  });

  it("truncates long text", () => {
    expect(summarizeAnchorText("a".repeat(200), 10)).toBe(`${"a".repeat(9)}…`);
  });
});

describe("anchorForActiveTurn", () => {
  const anchored = [
    assistantMessage("a1", "2026-08-19T10:00:01.000Z", "turn-1"),
    userMessage("u2", "2026-08-19T10:01:00.000Z", "a1"),
  ];

  it("attributes a turn that has not reported anything yet to the last reply", () => {
    const partition = partitionMessageThreads(anchored);
    expect(anchorForActiveTurn(partition, TurnId.make("turn-2"))).toBe(MessageId.make("a1"));
  });

  it("uses the turn's own attribution once it has produced something", () => {
    const partition = partitionMessageThreads([
      ...anchored,
      assistantMessage("a2", "2026-08-19T10:01:02.000Z", "turn-2"),
    ]);
    expect(anchorForActiveTurn(partition, TurnId.make("turn-2"))).toBe(MessageId.make("a1"));
    expect(anchorForActiveTurn(partition, TurnId.make("turn-1"))).toBeNull();
  });

  it("keeps a main-conversation turn out of a thread that is no longer the last word", () => {
    const partition = partitionMessageThreads([
      ...anchored,
      assistantMessage("a2", "2026-08-19T10:01:02.000Z", "turn-2"),
      userMessage("u3", "2026-08-19T10:02:00.000Z"),
      assistantMessage("a3", "2026-08-19T10:02:02.000Z", "turn-3"),
    ]);
    expect(anchorForActiveTurn(partition, TurnId.make("turn-3"))).toBeNull();
  });
});
