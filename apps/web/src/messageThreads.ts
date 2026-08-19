/**
 * Side threads: a reply hung off one earlier message instead of the end of the
 * conversation. Everything still runs in the one agent session — the model
 * keeps its full context and answers the quoted point — but the reply and the
 * turn it starts are filed under the message they are about, so three topics
 * in one answer stop turning into one tangled thread of three answers.
 *
 * Only the user message carries the anchor (`replyToMessageId`). Everything the
 * turn then produces — assistant text, tool work, plans — belongs to the same
 * side thread, which is what this module works out.
 */

import type { MessageId, TurnId } from "@t3tools/contracts";
import type { TimelineEntry } from "./session-logic";

export interface MessageThreadSummary {
  anchorMessageId: MessageId;
  /** Timeline entries in the side thread, oldest first. */
  entries: TimelineEntry[];
  /** User messages in the thread — "3 replies" counts what you said, not what came back. */
  replyCount: number;
  /** Timestamp of the newest entry, for the "last reply" label. */
  lastActivityAt: string;
  /** True while any message in the thread is still streaming. */
  streaming: boolean;
}

export interface MessageThreadPartition {
  /** Entries belonging to the main conversation, in timeline order. */
  mainEntries: TimelineEntry[];
  /** Side threads keyed by the message they hang off. */
  threadsByAnchorId: ReadonlyMap<MessageId, MessageThreadSummary>;
  /** Which side thread a turn belongs to — null-anchored turns are main. */
  anchorByTurnId: ReadonlyMap<TurnId, MessageId>;
  /**
   * Anchor of the most recent reply, whether or not its turn has produced
   * anything yet. Covers the gap between sending in a thread and the first
   * event coming back, when there is no turn id to attribute the work by.
   */
  trailingAnchorMessageId: MessageId | null;
  /** Turns that have produced at least one entry, so their anchor is settled. */
  seenTurnIds: ReadonlySet<TurnId>;
}

const EMPTY_PARTITION: MessageThreadPartition = {
  mainEntries: [],
  threadsByAnchorId: new Map(),
  anchorByTurnId: new Map(),
  trailingAnchorMessageId: null,
  seenTurnIds: new Set(),
};

function entryTurnId(entry: TimelineEntry): TurnId | null {
  switch (entry.kind) {
    case "message":
      return entry.message.turnId ?? null;
    case "work":
      return entry.entry.turnId ?? null;
    case "proposed-plan":
      return entry.proposedPlan.turnId;
    case "handoff":
      return null;
  }
}

/**
 * Split a thread's timeline into the main conversation and its side threads.
 *
 * A user message declares its own anchor. The turn it starts is only linked to
 * it by position — the client never learns which turn id a user message
 * produced — so the first entry carrying a turn id after that message claims
 * the turn for the same anchor, and from then on the turn id is what decides.
 * That keeps entries that arrive out of order (a late tool row, a re-sent
 * assistant delta) with the rest of their turn instead of with whatever
 * happened to be open at the time.
 */
export function partitionMessageThreads(
  timelineEntries: ReadonlyArray<TimelineEntry>,
): MessageThreadPartition {
  if (timelineEntries.length === 0) {
    return EMPTY_PARTITION;
  }

  const messageIds = new Set<MessageId>();
  for (const entry of timelineEntries) {
    if (entry.kind === "message") {
      messageIds.add(entry.message.id);
    }
  }

  const anchorByTurnId = new Map<TurnId, MessageId>();
  const seenTurnIds = new Set<TurnId>();
  const anchorByEntryId = new Map<string, MessageId>();
  let openAnchor: MessageId | null = null;
  let openTurnId: TurnId | null = null;
  let anyAnchored = false;

  for (const entry of timelineEntries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      const declared = entry.message.replyToMessageId ?? null;
      // An anchor pointing at a message that is no longer loaded (the client
      // keeps only a tail of long conversations) has nothing to hang off, so
      // the reply stays where it is rather than vanishing into a thread the
      // UI cannot open.
      openAnchor = declared !== null && messageIds.has(declared) ? declared : null;
      openTurnId = null;
      if (openAnchor !== null) {
        anyAnchored = true;
        anchorByEntryId.set(entry.id, openAnchor);
      }
      continue;
    }

    const turnId = entryTurnId(entry);
    if (turnId !== null) {
      seenTurnIds.add(turnId);
      const known = anchorByTurnId.get(turnId);
      if (known !== undefined) {
        anchorByEntryId.set(entry.id, known);
        continue;
      }
      if (openTurnId === null) {
        openTurnId = turnId;
        if (openAnchor !== null) {
          anchorByTurnId.set(turnId, openAnchor);
        }
      }
      if (turnId !== openTurnId) {
        // A turn we never saw open belongs to whatever started it, not to the
        // side thread that happens to be open here.
        continue;
      }
    }

    if (openAnchor !== null) {
      anchorByEntryId.set(entry.id, openAnchor);
    }
  }

  if (!anyAnchored) {
    return {
      mainEntries: timelineEntries as TimelineEntry[],
      threadsByAnchorId: new Map(),
      anchorByTurnId,
      trailingAnchorMessageId: null,
      seenTurnIds,
    };
  }

  const mainEntries: TimelineEntry[] = [];
  const threadsByAnchorId = new Map<MessageId, MessageThreadSummary>();

  for (const entry of timelineEntries) {
    const anchor = anchorByEntryId.get(entry.id);
    if (anchor === undefined) {
      mainEntries.push(entry);
      continue;
    }
    const existing = threadsByAnchorId.get(anchor);
    const summary: MessageThreadSummary = existing ?? {
      anchorMessageId: anchor,
      entries: [],
      replyCount: 0,
      lastActivityAt: entry.createdAt,
      streaming: false,
    };
    summary.entries.push(entry);
    if (entry.kind === "message" && entry.message.role === "user") {
      summary.replyCount += 1;
    }
    if (entry.createdAt > summary.lastActivityAt) {
      summary.lastActivityAt = entry.createdAt;
    }
    if (entry.kind === "message" && entry.message.streaming) {
      summary.streaming = true;
    }
    threadsByAnchorId.set(anchor, summary);
  }

  return {
    mainEntries,
    threadsByAnchorId,
    anchorByTurnId,
    trailingAnchorMessageId: openAnchor,
    seenTurnIds,
  };
}

/** The side thread an in-flight turn is running in, if any. */
export function anchorForActiveTurn(
  partition: MessageThreadPartition,
  activeTurnId: TurnId | null | undefined,
): MessageId | null {
  if (activeTurnId && partition.seenTurnIds.has(activeTurnId)) {
    // The turn has produced something, so its own attribution is the truth —
    // absent from the map means it belongs to the main conversation.
    return partition.anchorByTurnId.get(activeTurnId) ?? null;
  }
  // Nothing back from the turn yet: it belongs to whoever spoke last.
  return partition.trailingAnchorMessageId;
}

/** Short one-line preview of an anchor message for thread headers and chips. */
export function summarizeAnchorText(text: string, maxLength = 90): string {
  const collapsed = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<quote>[\s\S]*?<\/quote>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}
