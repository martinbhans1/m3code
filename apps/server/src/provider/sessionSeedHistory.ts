/**
 * sessionSeedHistory — rebuilding an agent's memory from our own transcript.
 *
 * A provider session is the agent's working memory, and it lives in the
 * provider's store, not ours: Claude Code keeps a JSONL transcript per session
 * and Codex keeps a rollout per thread. Both of those can disappear while the
 * conversation we show the user is still perfectly intact — Claude Code deletes
 * transcripts older than `cleanupPeriodDays` (30 by default), a config dir can
 * be swapped, a rollout can be rejected on resume. When that happens the thread
 * is unresumable, and before this module existed the turn simply errored out and
 * the conversation was dead for good.
 *
 * The conversation itself is never lost: every message is in
 * `projection_thread_messages`. So a session that cannot resume starts fresh and
 * is handed the visible history as text instead. That is strictly weaker than a
 * real resume — no tool results, no reasoning, no files the agent had open — so
 * the preamble says so explicitly rather than letting the agent assume it
 * remembers more than it does.
 *
 * Everything here is pure and bounded: a 500-message thread must not turn into a
 * prompt that the provider refuses.
 *
 * @module sessionSeedHistory
 */

/**
 * The tag the digest is wrapped in. Named in the preamble so the agent can tell
 * rebuilt history from anything the user typed, and used by the adapters to
 * recognize their own injected block.
 */
export const SEED_HISTORY_TAG = "rebuilt-conversation-history";

/**
 * How many of the most recent messages may be reproduced in full.
 *
 * The recent exchange is what the next turn is actually about, so it is worth
 * real tokens. Everything before it only needs to place the conversation.
 */
export const SEED_HISTORY_MAX_FULL_MESSAGES = 20;

/** Total character budget for the full-text window. */
export const SEED_HISTORY_FULL_TEXT_BUDGET = 24_000;

/**
 * Per-message ceiling inside the full-text window.
 *
 * One enormous message (a pasted log, a long plan) would otherwise eat the whole
 * budget and leave the rest of the exchange out, which reads as if the
 * conversation never happened.
 */
export const SEED_HISTORY_MAX_MESSAGE_CHARS = 6_000;

/** Characters kept per condensed older message. */
export const SEED_HISTORY_CONDENSED_PREVIEW_CHARS = 220;

/** How many older messages get a condensed line before we stop naming them. */
export const SEED_HISTORY_MAX_CONDENSED_MESSAGES = 60;

export interface SeedHistoryMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
  readonly streaming?: boolean;
}

export interface SeedHistoryStats {
  /** Messages reproduced in full. */
  readonly fullCount: number;
  /** Older messages reduced to one line each. */
  readonly condensedCount: number;
  /** Messages left out altogether because even their opening lines did not fit. */
  readonly droppedCount: number;
}

export interface SeedHistoryResult {
  readonly text: string;
  readonly stats: SeedHistoryStats;
}

/**
 * `2026-09-03T18:04:10.493Z` → `2026-09-03 18:04`. Minutes are enough to order a
 * conversation, and the stored value is already ISO-8601 UTC, so this is a
 * reslice rather than a date calculation.
 */
function formatSeedTimestamp(createdAt: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(createdAt);
  return match ? `${match[1]} ${match[2]}` : createdAt;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateTo(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, maxChars).trimEnd(), truncated: true };
}

/**
 * Messages worth seeding, in order, with the unanswered tail removed.
 *
 * Anything after the last assistant message has not been answered yet — it is
 * the prompt the caller is about to deliver live — so including it would show
 * the agent the same message twice and invite it to answer the older copy.
 */
export function selectSeedHistoryMessages(
  messages: ReadonlyArray<SeedHistoryMessage>,
): ReadonlyArray<SeedHistoryMessage> {
  const usable = messages.filter(
    (message) => message.streaming !== true && message.text.trim().length > 0,
  );
  let lastAnsweredIndex = -1;
  for (let index = usable.length - 1; index >= 0; index -= 1) {
    if (usable[index]?.role === "assistant") {
      lastAnsweredIndex = index;
      break;
    }
  }
  return lastAnsweredIndex === -1 ? [] : usable.slice(0, lastAnsweredIndex + 1);
}

/**
 * Render a thread's visible history as a bounded prompt preamble.
 *
 * Returns `undefined` when there is nothing to rebuild — a brand-new thread, or
 * one whose only message is the prompt about to be sent. Callers treat that as
 * "ordinary fresh session", with no notice and no preamble.
 */
export function renderSeedHistory(
  messages: ReadonlyArray<SeedHistoryMessage>,
  options?: {
    readonly reason?: string;
  },
): SeedHistoryResult | undefined {
  const selected = selectSeedHistoryMessages(messages);
  if (selected.length === 0) {
    return undefined;
  }

  // Walk backwards from the newest: the recent exchange is what the next turn
  // depends on, so it gets the budget first and older messages take what is left.
  const fullMessages: Array<{ message: SeedHistoryMessage; body: string; truncated: boolean }> = [];
  let remainingBudget = SEED_HISTORY_FULL_TEXT_BUDGET;
  let firstFullIndex = selected.length;
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    if (fullMessages.length >= SEED_HISTORY_MAX_FULL_MESSAGES) break;
    const message = selected[index];
    if (!message) break;
    const trimmed = message.text.trim();
    const perMessageCap = Math.min(SEED_HISTORY_MAX_MESSAGE_CHARS, remainingBudget);
    // Never emit a message stub so short it says nothing; stop instead and let
    // the rest be condensed, where a 220-character preview is the whole point.
    if (perMessageCap < SEED_HISTORY_CONDENSED_PREVIEW_CHARS) break;
    const { text: body, truncated } = truncateTo(trimmed, perMessageCap);
    fullMessages.push({ message, body, truncated });
    remainingBudget -= body.length;
    firstFullIndex = index;
  }
  fullMessages.reverse();

  const older = selected.slice(0, firstFullIndex);
  const condensedSource = older.slice(-SEED_HISTORY_MAX_CONDENSED_MESSAGES);
  const droppedCount = older.length - condensedSource.length;

  const lines: Array<string> = [];
  lines.push(`<${SEED_HISTORY_TAG}>`);
  lines.push(
    "Your previous agent session for this conversation could no longer be resumed" +
      (options?.reason ? ` (${options.reason})` : "") +
      ", so you are starting fresh. This is not a new conversation: the exchange below",
  );
  lines.push(
    "already happened and the user can see all of it in the thread. It was rebuilt from" +
      " the messages this app stores, so it is text only — none of the tool output,",
  );
  lines.push(
    "reasoning, file state or working context from those turns survived. Treat it as your" +
      " own prior work, rely on nothing beyond it, and re-check the current state of",
  );
  lines.push(
    "anything you are told you did rather than assuming it is still true. If the user" +
      " asks about something that is not here, say plainly that it is outside the",
  );
  lines.push("history you were given.");
  lines.push("");

  if (condensedSource.length > 0) {
    const preamble =
      droppedCount > 0
        ? `Earlier in this conversation — the ${condensedSource.length} most recent of ${older.length} earlier messages, opening lines only (${droppedCount} older messages omitted):`
        : `Earlier in this conversation — opening lines only (${condensedSource.length} message${condensedSource.length === 1 ? "" : "s"}):`;
    lines.push(preamble);
    for (const message of condensedSource) {
      const { text: preview, truncated } = truncateTo(
        collapseWhitespace(message.text),
        SEED_HISTORY_CONDENSED_PREVIEW_CHARS,
      );
      lines.push(
        `- [${message.role} ${formatSeedTimestamp(message.createdAt)}] ${preview}${truncated ? " […]" : ""}`,
      );
    }
    lines.push("");
  }

  lines.push(
    fullMessages.length === 1
      ? "The most recent message, in full:"
      : `The ${fullMessages.length} most recent messages, in full:`,
  );
  for (const entry of fullMessages) {
    lines.push("");
    lines.push(`### ${entry.message.role} — ${formatSeedTimestamp(entry.message.createdAt)}`);
    lines.push(entry.body);
    if (entry.truncated) {
      lines.push("[… message truncated to fit]");
    }
  }
  lines.push("");
  lines.push(`</${SEED_HISTORY_TAG}>`);

  return {
    text: lines.join("\n"),
    stats: {
      fullCount: fullMessages.length,
      condensedCount: condensedSource.length,
      droppedCount,
    },
  };
}

/**
 * The shape of a thread message as the read model hands it over. Structural so
 * this module stays independent of the orchestration contracts.
 */
export interface ThreadSeedHistoryMessage {
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
  readonly streaming: boolean;
  readonly replyToMessageId: string | null;
}

/**
 * Render a thread's own messages as seed history.
 *
 * Side-thread replies are left out: they hang off one earlier message and read
 * as non-sequiturs once flattened into a linear transcript. System messages are
 * left out too — they are app notices, not conversation.
 */
export function renderSeedHistoryForThread(
  messages: ReadonlyArray<ThreadSeedHistoryMessage>,
): SeedHistoryResult | undefined {
  return renderSeedHistory(
    messages.flatMap((message) =>
      message.replyToMessageId === null && (message.role === "user" || message.role === "assistant")
        ? [
            {
              role: message.role,
              text: message.text,
              createdAt: message.createdAt,
              streaming: message.streaming,
            },
          ]
        : [],
    ),
  );
}

/**
 * Why a session had to be rebuilt, in the user's terms.
 *
 * These are the only three ways it happens, and the distinction matters to the
 * user: an expired transcript is housekeeping they can prevent, a rejected one
 * is a provider bug, and "never had one" is simply a thread moving to an agent
 * that was not there for the original conversation.
 */
export type SeedHistoryReason = "expired" | "rejected" | "absent";

const SEED_HISTORY_REASON_TEXT: Record<SeedHistoryReason, string> = {
  expired: "the agent's saved session had expired",
  rejected: "the agent's saved session could not be reopened",
  absent: "this agent had no saved session for this conversation",
};

/**
 * The one-line notice the thread shows when this happened.
 *
 * Deliberately honest about the limit: the user needs to know the agent is
 * working from what is on screen, not from everything it used to know. Kept
 * inside the 120 characters the work log shows as a row label.
 */
export function seedHistoryNoticeMessage(reason: SeedHistoryReason): string {
  return `Memory rebuilt from the visible history — ${SEED_HISTORY_REASON_TEXT[reason]}.`;
}

/** The longer form, for the notice's detail payload. */
export function describeSeedHistory(reason: SeedHistoryReason, stats: SeedHistoryStats): string {
  const parts: Array<string> = [
    `${stats.fullCount} recent message${stats.fullCount === 1 ? "" : "s"} in full`,
  ];
  if (stats.condensedCount > 0) {
    parts.push(`${stats.condensedCount} earlier summarised`);
  }
  if (stats.droppedCount > 0) {
    parts.push(`${stats.droppedCount} older omitted`);
  }
  return `${SEED_HISTORY_REASON_TEXT[reason]}, so the agent was given this conversation's visible history instead (${parts.join(", ")}). Tool output, reasoning and working context from the earlier turns are gone.`;
}
