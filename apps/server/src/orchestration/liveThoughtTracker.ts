/**
 * Turns streamed provider reasoning into the one-line "latest thought" shown
 * while a turn runs.
 *
 * Pure and synchronous so the ingestion worker can call it on every runtime
 * event; the `ThreadLiveThoughts` layer owns publishing. Nothing here is ever
 * persisted — a thread holds at most one line, replaced as the agent thinks
 * and dropped when the turn ends.
 *
 * - Codex reasoning summaries win over raw reasoning for the same item: once
 *   an item streams a summary, its raw reasoning deltas are ignored.
 * - Each summary part stands alone (its bold heading becomes the line). Raw
 *   reasoning is read paragraph by paragraph, so a long Claude thinking block
 *   keeps moving instead of pinning its first sentence.
 * - Publishing is throttled per thread and deduped on the derived line; any
 *   other agent activity (text, tool start/finish) flushes the pending line,
 *   and the owning layer calls `flushPending` once the throttle window passes
 *   so a stream that goes quiet still shows its last words.
 *
 * @module orchestration/liveThoughtTracker
 */
import type {
  OrchestrationThreadLiveThought,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { LIVE_THOUGHT_MAX_CHARS, liveThoughtLine } from "@t3tools/shared/liveThought";

/** Minimum gap between two published lines for one thread. */
export const LIVE_THOUGHT_THROTTLE_MS = 300;
/** Longest reasoning segment kept in memory; the line comes from its start. */
const SEGMENT_BUFFER_MAX_CHARS = 4_000;
/** Newest characters kept past the cap; enough to hold a whole paragraph break. */
const SEGMENT_TAIL_CHARS = 16;
const PARAGRAPH_BREAK = /\n[ \t]*\r?\n/g;

interface ThreadThoughtState {
  readonly turnId: TurnId;
  /** Identity of the reasoning block being streamed; `null` once it closed. */
  blockKey: string | null;
  /** Item whose summary has started streaming; its raw reasoning is ignored. */
  summaryItemKey: string | null;
  segment: string;
  dirty: boolean;
  /** `createdAt` of the newest reasoning delta folded into `segment`. */
  pendingAt: string;
  published: OrchestrationThreadLiveThought | null;
  publishedAtMs: number;
}

export interface LiveThoughtUpdate {
  readonly threadId: ThreadId;
  readonly liveThought: OrchestrationThreadLiveThought | null;
}

export interface LiveThoughtTracker {
  /** Feed one runtime event; returns the update to publish, if any. */
  readonly observe: (event: ProviderRuntimeEvent) => LiveThoughtUpdate | undefined;
  /** Latest published thought for a thread, for late subscribers. */
  readonly current: (threadId: ThreadId) => OrchestrationThreadLiveThought | null;
  /** Whether a thread holds reasoning the throttle has not published yet. */
  readonly hasPending: (threadId: ThreadId) => boolean;
  /** Publish a thread's held-back reasoning now (the throttle's trailing edge). */
  readonly flushPending: (threadId: ThreadId) => LiveThoughtUpdate | undefined;
}

function lastParagraph(text: string): string {
  let start = 0;
  for (const match of text.matchAll(PARAGRAPH_BREAK)) {
    start = match.index + match[0].length;
  }
  return start === 0 ? text : text.slice(start);
}

function clampLine(line: string): string {
  return line.length <= LIVE_THOUGHT_MAX_CHARS
    ? line
    : `${line.slice(0, LIVE_THOUGHT_MAX_CHARS - 1).trimEnd()}…`;
}

export function makeLiveThoughtTracker(options?: {
  readonly throttleMs?: number;
}): LiveThoughtTracker {
  const throttleMs = options?.throttleMs ?? LIVE_THOUGHT_THROTTLE_MS;
  const states = new Map<ThreadId, ThreadThoughtState>();

  const flush = (
    threadId: ThreadId,
    state: ThreadThoughtState,
    at: string,
    atMs: number,
  ): LiveThoughtUpdate | undefined => {
    if (!state.dirty) return undefined;
    state.dirty = false;
    const text = clampLine(liveThoughtLine(state.segment));
    if (text.length === 0 || text === state.published?.text) return undefined;
    state.published = { turnId: state.turnId, text, updatedAt: at };
    state.publishedAtMs = atMs;
    return { threadId, liveThought: state.published };
  };

  const clear = (threadId: ThreadId): LiveThoughtUpdate | undefined => {
    const state = states.get(threadId);
    if (!state) return undefined;
    states.delete(threadId);
    return state.published ? { threadId, liveThought: null } : undefined;
  };

  const observe: LiveThoughtTracker["observe"] = (event) => {
    switch (event.type) {
      // Turn events are scoped to their turn: a late completion or a duplicate
      // start for some other turn must not wipe the running turn's thought.
      case "turn.started":
        return states.get(event.threadId)?.turnId === event.turnId
          ? undefined
          : clear(event.threadId);
      case "turn.completed":
      case "turn.aborted": {
        const turnId = states.get(event.threadId)?.turnId;
        return event.turnId === undefined || event.turnId === turnId
          ? clear(event.threadId)
          : undefined;
      }
      case "session.exited":
        return clear(event.threadId);
      case "content.delta":
        if (
          event.payload.streamKind === "reasoning_text" ||
          event.payload.streamKind === "reasoning_summary_text"
        ) {
          return observeReasoning(event);
        }
        return closeBlock(event);
      case "item.started":
      case "item.completed":
      case "turn.proposed.delta":
        return closeBlock(event);
      default:
        return undefined;
    }
  };

  const closeBlock = (event: ProviderRuntimeEvent): LiveThoughtUpdate | undefined => {
    const state = states.get(event.threadId);
    if (!state || state.blockKey === null) return undefined;
    state.blockKey = null;
    return flush(event.threadId, state, event.createdAt, Date.parse(event.createdAt));
  };

  const observeReasoning = (
    event: Extract<ProviderRuntimeEvent, { type: "content.delta" }>,
  ): LiveThoughtUpdate | undefined => {
    const turnId = event.turnId;
    if (turnId === undefined || event.payload.delta.length === 0) return undefined;

    let state = states.get(event.threadId);
    if (!state || state.turnId !== turnId) {
      state = {
        turnId,
        blockKey: null,
        summaryItemKey: null,
        segment: "",
        dirty: false,
        pendingAt: event.createdAt,
        published: null,
        publishedAtMs: Number.NEGATIVE_INFINITY,
      };
      states.set(event.threadId, state);
    }

    const itemKey = event.itemId ?? "";
    const isSummary = event.payload.streamKind === "reasoning_summary_text";
    if (!isSummary && state.summaryItemKey === itemKey) return undefined;
    if (isSummary) state.summaryItemKey = itemKey;

    const blockKey = isSummary
      ? `${itemKey}|summary|${event.payload.summaryIndex ?? ""}`
      : `${itemKey}|raw|${event.payload.contentIndex ?? ""}`;
    const continuing = state.blockKey === blockKey;
    state.blockKey = blockKey;

    const combined = (continuing ? state.segment : "") + event.payload.delta;
    const segment = isSummary ? combined : lastParagraph(combined);
    // Over the cap, keep the start (the line comes from there) plus a short
    // tail, so a paragraph break split across two deltas is still seen.
    state.segment =
      segment.length <= SEGMENT_BUFFER_MAX_CHARS
        ? segment
        : segment.slice(0, SEGMENT_BUFFER_MAX_CHARS - SEGMENT_TAIL_CHARS) +
          segment.slice(-SEGMENT_TAIL_CHARS);
    state.dirty = true;
    state.pendingAt = event.createdAt;

    const atMs = Date.parse(event.createdAt);
    if (atMs - state.publishedAtMs < throttleMs) return undefined;
    return flush(event.threadId, state, event.createdAt, atMs);
  };

  return {
    observe,
    current: (threadId) => states.get(threadId)?.published ?? null,
    hasPending: (threadId) => states.get(threadId)?.dirty === true,
    flushPending: (threadId) => {
      const state = states.get(threadId);
      return state
        ? flush(threadId, state, state.pendingAt, Date.parse(state.pendingAt))
        : undefined;
    },
  };
}
