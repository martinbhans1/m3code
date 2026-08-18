import type { OrchestrationThreadSearchResult } from "@t3tools/contracts";

export const CONVERSATION_SEARCH_MODEL = "Xenova/bge-small-en-v1.5@q8";
export const CONVERSATION_SEARCH_DIMENSIONS = 384;
export const CONVERSATION_SEARCH_CHUNK_CHARS = 2_000;
const CONVERSATION_SEARCH_CHUNK_OVERLAP_CHARS = 240;

export interface SearchableConversationMessage {
  readonly threadId: string;
  readonly title: string;
  readonly projectTitle: string;
  readonly branch: string | null;
  readonly messageId: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
}

export interface ConversationSearchChunk {
  readonly chunkId: string;
  readonly threadId: string;
  readonly text: string;
}

function splitLongText(text: string): string[] {
  if (text.length <= CONVERSATION_SEARCH_CHUNK_CHARS) return [text];
  const step = CONVERSATION_SEARCH_CHUNK_CHARS - CONVERSATION_SEARCH_CHUNK_OVERLAP_CHARS;
  const parts: string[] = [];
  for (let offset = 0; offset < text.length; offset += step) {
    parts.push(text.slice(offset, offset + CONVERSATION_SEARCH_CHUNK_CHARS));
    if (offset + CONVERSATION_SEARCH_CHUNK_CHARS >= text.length) break;
  }
  return parts;
}

function semanticDocumentPrefix(message: SearchableConversationMessage): string {
  return [
    `Title: ${message.title}`,
    `Project: ${message.projectTitle}`,
    ...(message.branch ? [`Branch: ${message.branch}`] : []),
  ].join("\n");
}

export function buildConversationSearchChunks(
  messages: ReadonlyArray<SearchableConversationMessage>,
): ConversationSearchChunk[] {
  const chunks: ConversationSearchChunk[] = [];
  let activeThreadId: string | null = null;
  let activePrefix = "";
  let activeBody = "";
  let activeIndex = 0;

  const flush = () => {
    if (activeThreadId === null || activeBody.length === 0) return;
    chunks.push({
      chunkId: `${activeThreadId}:${activeIndex}`,
      threadId: activeThreadId,
      text: `${activePrefix}\n\n${activeBody}`,
    });
    activeIndex += 1;
    activeBody = "";
  };

  for (const message of messages) {
    if (message.threadId !== activeThreadId) {
      flush();
      activeThreadId = message.threadId;
      activePrefix = semanticDocumentPrefix(message);
      activeBody = "";
      activeIndex = 0;
    }

    const roleLabel =
      message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "System";
    const messageText = `[${roleLabel}] ${message.text.trim()}`;
    for (const part of splitLongText(messageText)) {
      const separatorLength = activeBody.length === 0 ? 0 : 2;
      if (activeBody.length + separatorLength + part.length > CONVERSATION_SEARCH_CHUNK_CHARS) {
        flush();
      }
      activeBody = activeBody.length === 0 ? part : `${activeBody}\n\n${part}`;
    }
  }
  flush();
  return chunks;
}

/**
 * Terms too common to narrow anything, and ruinous to match on.
 *
 * The FTS5 index has no `prefix=` table, so a prefix term is answered by walking
 * every term in the vocabulary that starts with it. For a word like "the" that
 * is most of the vocabulary — measured at 124s for `"the"*` alone against a
 * 27k-message index, against 0.5s for a distinctive word. Dropping these costs
 * nothing in recall: a term present in nearly every message cannot discriminate
 * between them, and the phrase-level scoring in `searchContent` still rewards
 * rows that contain the user's wording verbatim.
 */
const FTS_STOPWORDS = new Set([
  "a",
  "about",
  "all",
  "also",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "get",
  "got",
  "had",
  "has",
  "have",
  "he",
  "her",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "like",
  "make",
  "made",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "one",
  "or",
  "our",
  "out",
  "over",
  "she",
  "should",
  "so",
  "some",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "two",
  "up",
  "use",
  "used",
  "was",
  "way",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

/**
 * Enough terms to pin down a topic; past this each extra one only adds doclist
 * work. Long dictated queries are the case that used to time out, and their
 * tail is almost always filler rather than signal.
 */
const MAX_FTS_TERMS = 6;

/** Below this a prefix term matches too much of the vocabulary to be worth it. */
const MIN_PREFIX_TERM_LENGTH = 4;

const FTS_TERM_SEPARATOR = " AND ";

/**
 * Build the FTS5 MATCH expression for a user's search phrase.
 *
 * Only the token the user typed last is prefix-matched, and only when it is long
 * enough to be selective — that keeps typeahead behaviour on the word still
 * being written without paying the prefix-expansion cost on every other word.
 * Returns null when nothing discriminating survives, which the caller reads as
 * "skip the content index"; title and semantic matching still run.
 */
export function buildFtsQuery(query: string): string | null {
  const tokens = query
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu)
    ?.filter((token) => token.length > 0);
  if (!tokens || tokens.length === 0) return null;

  const lastToken = tokens.at(-1);
  const distinct = [...new Set(tokens)];
  const meaningful = distinct.filter((token) => token.length > 1 && !FTS_STOPWORDS.has(token));
  // A query made entirely of stopwords ("the", "how do I") has no content term
  // to search on. Matching it anyway would scan most of the index to return the
  // arbitrary rows that happen to rank first.
  if (meaningful.length === 0) return null;

  // Longer terms are the more selective ones, so they are what survives the cap
  // — except for the trailing token, which is pinned. It is the one the user is
  // still typing and the only one that gets prefix-matched, so letting the cap
  // drop it would silently search for everything except the word being written.
  // Emit in the user's own order afterwards; FTS5 does not care, but it keeps
  // the expression readable in logs.
  const pinned = meaningful.filter((token) => token === lastToken);
  const capped = new Set([
    ...pinned,
    ...meaningful
      .filter((token) => token !== lastToken)
      .toSorted((left, right) => right.length - left.length)
      .slice(0, MAX_FTS_TERMS - pinned.length),
  ]);

  return meaningful
    .filter((token) => capped.has(token))
    .map((token) => {
      const escaped = token.replaceAll('"', '""');
      return token === lastToken && token.length >= MIN_PREFIX_TERM_LENGTH
        ? `"${escaped}"*`
        : `"${escaped}"`;
    })
    .join(FTS_TERM_SEPARATOR);
}

/**
 * Loosen a MATCH expression from "every term" to "any term".
 *
 * `buildFtsQuery` requires all terms, which is right when the user's wording
 * matches the conversation's — and finds nothing when it does not. Someone
 * describing work from memory ("the one where we were fixing the email
 * templates") rarely reproduces the exact vocabulary, and one absent word would
 * otherwise sink the whole query. Falling back to any-term keeps bm25 ranking
 * the threads that matched the most terms first, so precision degrades in order
 * rather than collapsing.
 *
 * Returns null when there is only one term, which is already as loose as it gets.
 */
export function relaxFtsQuery(ftsQuery: string): string | null {
  return ftsQuery.includes(FTS_TERM_SEPARATOR)
    ? ftsQuery.replaceAll(FTS_TERM_SEPARATOR, " OR ")
    : null;
}

export function dotProduct(left: Float32Array, right: Float32Array): number {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    total += left[index]! * right[index]!;
  }
  return total;
}

export function toEmbeddingBytes(embedding: Float32Array): Uint8Array {
  return new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

export function fromEmbeddingBytes(bytes: Uint8Array): Float32Array {
  const copy = Uint8Array.from(bytes);
  return new Float32Array(copy.buffer);
}

/**
 * How results are ordered for reading, best band first.
 *
 * The score decides which threads make the cut; the band decides how the ones
 * that made it are laid out. Inside a band the order is newest first, because
 * the differences the scorer draws there — bm25 between two threads that both
 * match every term, the fifth decimal of a cosine — are invisible to whoever is
 * reading the list, and a list whose dates jump around reads as unordered.
 * Between bands the score still rules: a verbatim hit never sits under a
 * fresher guess.
 */
export const THREAD_SEARCH_BAND = {
  /** Contains the search string verbatim. */
  exact: 6,
  /** The thread's own title matched. */
  title: 5,
  /** Matched on the project name or branch rather than the thread itself. */
  metadata: 4,
  /** A message contained every search term. */
  content: 3,
  /** Recognized by meaning, with none of the words necessarily present. */
  semantic: 2,
  /** Matched only some of the terms, after the all-terms search found nothing. */
  loose: 1,
} as const;

export type ThreadSearchBand = (typeof THREAD_SEARCH_BAND)[keyof typeof THREAD_SEARCH_BAND];

/** A result carrying the band it should be read in; internal to search. */
export interface BandedThreadSearchResult extends OrchestrationThreadSearchResult {
  readonly band: ThreadSearchBand;
}

/**
 * Flatten each band to one score before the result leaves the server.
 *
 * The palette searches several environments and merges the responses by score,
 * so a score that still varied inside a band would resurrect the ordering this
 * function exists to replace. One score per band means any downstream sort of
 * "score, then recency" reproduces exactly what the server decided.
 */
export function toOrderedThreadSearchResults(
  results: ReadonlyArray<BandedThreadSearchResult>,
): OrchestrationThreadSearchResult[] {
  return results
    .toSorted(
      (left, right) => right.band - left.band || right.updatedAt.localeCompare(left.updatedAt),
    )
    .map(({ band, ...result }) => ({ ...result, score: band * 1_000 }));
}

export function mergeHybridThreadSearchResults(input: {
  readonly lexical: ReadonlyArray<BandedThreadSearchResult>;
  readonly semantic: ReadonlyArray<BandedThreadSearchResult>;
  readonly limit: number;
}): BandedThreadSearchResult[] {
  const byThreadId = new Map<
    string,
    { result: BandedThreadSearchResult; lexicalRank?: number; semanticRank?: number }
  >();

  input.lexical.forEach((result, lexicalRank) => {
    byThreadId.set(result.threadId, { result, lexicalRank });
  });
  input.semantic.forEach((result, semanticRank) => {
    const existing = byThreadId.get(result.threadId);
    if (existing) {
      byThreadId.set(result.threadId, {
        result: {
          ...existing.result,
          matchKind: "hybrid",
          band: Math.max(existing.result.band, result.band) as ThreadSearchBand,
          score: existing.result.score + result.score * 0.2,
        },
        ...(existing.lexicalRank === undefined ? {} : { lexicalRank: existing.lexicalRank }),
        semanticRank,
      });
      return;
    }
    byThreadId.set(result.threadId, { result, semanticRank });
  });

  return [...byThreadId.values()]
    .map((entry) => ({
      ...entry.result,
      score:
        entry.result.score +
        (entry.lexicalRank === undefined ? 0 : 2 / (60 + entry.lexicalRank)) +
        (entry.semanticRank === undefined ? 0 : 1 / (60 + entry.semanticRank)),
    }))
    .toSorted(
      (left, right) =>
        right.band - left.band ||
        right.score - left.score ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, input.limit);
}
