import {
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  type OrchestrationThreadSearchResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import {
  buildConversationSearchChunks,
  buildFtsQuery,
  CONVERSATION_SEARCH_DIMENSIONS,
  CONVERSATION_SEARCH_MODEL,
  dotProduct,
  fromEmbeddingBytes,
  MAX_SEMANTIC_THREADS,
  mergeHybridThreadSearchResults,
  relaxFtsQuery,
  semanticSimilarityFloor,
  THREAD_SEARCH_BAND,
  toEmbeddingBytes,
  toOrderedThreadSearchResults,
  type BandedThreadSearchResult,
  type ConversationSearchChunk,
  type SearchableConversationMessage,
} from "./logic.ts";

const MAX_SEARCH_RESULTS = 50;
const DEFAULT_SEARCH_RESULTS = 20;
const SEMANTIC_BATCH_SIZE = 32;
const SEMANTIC_DIRTY_THREAD_BATCH_SIZE = 50;
const SEMANTIC_CANDIDATE_MULTIPLIER = 4;
/** A thread containing every search term outranks anything found another way. */
const STRICT_CONTENT_BASE_SCORE = 700;
/**
 * Partial keyword matches rank below *every* semantic match, not merely below
 * the strong ones: the floor here plus its largest bonuses (80 + 25 = 105) stays
 * under the weakest score `searchSemantic` can emit (`MIN_SEMANTIC_SIMILARITY`
 * × 500 = 260).
 *
 * This ordering is the whole point of the relaxed pass. It only runs when the
 * all-terms search found nothing, which is exactly when the user has described
 * work from memory rather than quoted it — the case the embedding index is best
 * at and bare keyword overlap is worst at. Interleaving the two bands is not
 * enough, because the relaxed pass returns matches by the dozen: forty threads
 * that merely share the word "fixing" will crowd out the one thread the
 * embedding actually recognized however the two are scored, unless the whole
 * loose band sits underneath. These are the results you show when there is
 * nothing better, so they must never displace something better.
 */
const LOOSE_CONTENT_BASE_SCORE = 150;
/** Certainty outranks relevance: a verbatim hit is not a guess. */
const EXACT_BASE_SCORE = 1_500;
/** Rows scanned per requested result, to allow for several hits in one thread. */
const EXACT_CANDIDATE_MULTIPLIER = 8;
/**
 * A trigram index cannot represent a query shorter than its trigrams. Below this
 * it matches nothing at all rather than reporting that it cannot help, so the
 * prefilter is dropped and the scan answers on its own.
 */
const TRIGRAM_MIN_QUERY_CHARS = 3;
const EXACT_SNIPPET_CHARS = 200;
/** How much of the snippet sits before the match rather than after it. */
const EXACT_SNIPPET_LEAD = 60;
const SEMANTIC_INDEX_FORMAT = "incremental-v1";
const SEMANTIC_QUERY_BUDGET = "500 millis";

export class ConversationSearchError extends Schema.TaggedErrorClass<ConversationSearchError>()(
  "ConversationSearchError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ConversationSearchShape {
  readonly search: (
    input: OrchestrationSearchThreadsInput,
  ) => Effect.Effect<OrchestrationSearchThreadsResult, ConversationSearchError>;
}

export class ConversationSearch extends Context.Service<
  ConversationSearch,
  ConversationSearchShape
>()("t3/conversationSearch/ConversationSearch") {}

interface ThreadMetadataRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly projectTitle: string;
  readonly branch: string | null;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
  readonly metadataRank: number;
}

interface ContentSearchRow extends Omit<ThreadMetadataRow, "metadataRank"> {
  readonly role: string;
  readonly text: string;
  readonly snippet: string | null;
  readonly ftsRank: number;
}

interface ExactSearchRow extends Omit<ThreadMetadataRow, "metadataRank"> {
  readonly role: string;
  readonly text: string;
  /** 1-based index of the match within `text`, as returned by `instr`. */
  readonly matchOffset: number;
  readonly createdAt: string;
}

interface SemanticStateRow {
  readonly model: string;
  readonly sourceFingerprint: string;
}

interface DirtyThreadRow {
  readonly threadId: string;
}

interface SemanticChunkRow {
  readonly chunkId: string;
  readonly threadId: string;
  readonly text: string;
  readonly embedding: Uint8Array;
}

interface SemanticThreadMetadataRow extends Omit<ThreadMetadataRow, "metadataRank"> {}

interface LoadedSemanticChunk extends ConversationSearchChunk {
  readonly embedding: Float32Array;
}

interface LocalEmbeddingOutput {
  readonly tolist: () => unknown;
}

type LocalEmbeddingPipeline = (
  texts: ReadonlyArray<string>,
  options: { readonly pooling: "mean"; readonly normalize: true },
) => Promise<LocalEmbeddingOutput>;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || limit <= 0) return DEFAULT_SEARCH_RESULTS;
  return Math.min(MAX_SEARCH_RESULTS, Math.trunc(limit));
}

function messageRole(value: string): "user" | "assistant" | "system" | null {
  return value === "user" || value === "assistant" || value === "system" ? value : null;
}

function toBaseResult(
  row: SemanticThreadMetadataRow,
): Omit<OrchestrationThreadSearchResult, "matchKind" | "score" | "snippet" | "matchedRole"> {
  return {
    threadId: ThreadId.make(row.threadId),
    projectId: ProjectId.make(row.projectId),
    title: row.title,
    projectTitle: row.projectTitle,
    branch: row.branch,
    archivedAt: row.archivedAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Wrap a raw search string as one FTS5 string literal.
 *
 * Everything inside the quotes is data to the trigram tokenizer — no operator,
 * wildcard or column filter is interpreted — so doubling embedded quotes is the
 * whole of the escaping needed. Without it a query containing `"` is a syntax
 * error rather than a search.
 */
function toTrigramMatch(query: string): string {
  return `"${query.replaceAll('"', '""')}"`;
}

/**
 * A window around the literal hit, so the caller can see the string in context
 * rather than the opening words of whatever message contained it.
 */
function exactSnippet(text: string, matchOffset: number): string {
  const start = Math.max(0, matchOffset - 1 - EXACT_SNIPPET_LEAD);
  const slice = text.slice(start, start + EXACT_SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${slice.trim()}${start + EXACT_SNIPPET_CHARS < text.length ? "…" : ""}`;
}

function semanticSnippet(text: string): string {
  const withoutMetadata = text.replace(/^(?:Title|Project|Branch):.*\n/gmu, "").trim();
  return withoutMetadata.length <= 280 ? withoutMetadata : `${withoutMetadata.slice(0, 277)}…`;
}

const makeConversationSearch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;

  let semanticStatus: OrchestrationSearchThreadsResult["semanticStatus"] = "indexing";
  let semanticChunks: ReadonlyArray<LoadedSemanticChunk> = [];
  let semanticBuildStarted = false;
  let extractor: LocalEmbeddingPipeline | null = null;

  const getExtractor = Effect.fn("ConversationSearch.getExtractor")(function* () {
    if (extractor) return extractor;
    const transformers = yield* Effect.tryPromise({
      try: () => import("@huggingface/transformers"),
      catch: (cause) =>
        new ConversationSearchError({ message: "Failed to load local embedding runtime.", cause }),
    });
    transformers.env.cacheDir = `${config.providerStatusCacheDir}/conversation-search-models`;
    transformers.env.allowRemoteModels = true;
    extractor = (yield* Effect.tryPromise({
      try: () =>
        transformers.pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", {
          dtype: "q8",
        }),
      catch: (cause) =>
        new ConversationSearchError({ message: "Failed to load local embedding model.", cause }),
    })) as unknown as LocalEmbeddingPipeline;
    return extractor;
  });

  const embedTexts = Effect.fn("ConversationSearch.embedTexts")(function* (
    texts: ReadonlyArray<string>,
    kind: "query" | "document",
  ) {
    const model = yield* getExtractor();
    const prefixedTexts =
      kind === "query"
        ? texts.map((text) => `Represent this sentence for searching relevant passages: ${text}`)
        : [...texts];
    const output = yield* Effect.tryPromise({
      try: () => model(prefixedTexts, { pooling: "mean", normalize: true }),
      catch: (cause) =>
        new ConversationSearchError({ message: "Local embedding inference failed.", cause }),
    });
    return (output.tolist() as number[][]).map((values) => Float32Array.from(values));
  });

  const loadPersistedSemanticChunks = Effect.fn("ConversationSearch.loadPersistedSemanticChunks")(
    function* () {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
          INSERT OR IGNORE INTO conversation_search_semantic_dirty_threads(thread_id)
          SELECT thread_id FROM conversation_search_semantic_processing_threads
        `;
          yield* sql`DELETE FROM conversation_search_semantic_processing_threads`;
        }),
      );
      const stateRows = yield* sql<SemanticStateRow>`
      SELECT model, source_fingerprint AS "sourceFingerprint"
      FROM conversation_search_semantic_state
      WHERE singleton = 1
    `;
      const state = stateRows[0];
      if (
        !state ||
        state.model !== CONVERSATION_SEARCH_MODEL ||
        state.sourceFingerprint !== SEMANTIC_INDEX_FORMAT
      ) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM conversation_search_semantic_chunks`;
            yield* sql`
            INSERT OR IGNORE INTO conversation_search_semantic_dirty_threads(thread_id)
            SELECT thread.thread_id
            FROM projection_threads AS thread
            JOIN projection_projects AS project ON project.project_id = thread.project_id
            WHERE thread.deleted_at IS NULL AND project.deleted_at IS NULL
          `;
            yield* sql`
            INSERT INTO conversation_search_semantic_state (
              singleton,
              model,
              source_fingerprint,
              indexed_at
            ) VALUES (1, ${CONVERSATION_SEARCH_MODEL}, ${SEMANTIC_INDEX_FORMAT}, CURRENT_TIMESTAMP)
            ON CONFLICT (singleton) DO UPDATE SET
              model = excluded.model,
              source_fingerprint = excluded.source_fingerprint,
              indexed_at = excluded.indexed_at
          `;
          }),
        );
      }
      const rows = yield* sql<SemanticChunkRow>`
      SELECT
        chunk_id AS "chunkId",
        thread_id AS "threadId",
        text,
        embedding
      FROM conversation_search_semantic_chunks
      WHERE model = ${CONVERSATION_SEARCH_MODEL}
        AND dimensions = ${CONVERSATION_SEARCH_DIMENSIONS}
        AND source_fingerprint = ${SEMANTIC_INDEX_FORMAT}
      ORDER BY chunk_id ASC
    `;
      semanticChunks = rows.map((row) => ({
        chunkId: row.chunkId,
        threadId: row.threadId,
        text: row.text,
        embedding: fromEmbeddingBytes(row.embedding),
      }));
    },
  );

  const rebuildDirtyThreads = Effect.fn("ConversationSearch.rebuildDirtyThreads")(function* () {
    if (semanticBuildStarted) return false;
    semanticBuildStarted = true;
    let claimedThreadIds: ReadonlyArray<string> = [];
    let messages: ReadonlyArray<SearchableConversationMessage> = [];
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const dirtyRows = yield* sql<DirtyThreadRow>`
          SELECT thread_id AS "threadId"
          FROM conversation_search_semantic_dirty_threads
          ORDER BY thread_id ASC
          LIMIT ${SEMANTIC_DIRTY_THREAD_BATCH_SIZE}
        `;
        claimedThreadIds = dirtyRows.map((row) => row.threadId);
        if (claimedThreadIds.length === 0) return;
        yield* sql`
          INSERT OR IGNORE INTO conversation_search_semantic_processing_threads(thread_id)
          SELECT thread_id
          FROM conversation_search_semantic_dirty_threads
          ORDER BY thread_id ASC
          LIMIT ${SEMANTIC_DIRTY_THREAD_BATCH_SIZE}
        `;
        yield* sql`
          DELETE FROM conversation_search_semantic_dirty_threads
          WHERE thread_id IN (SELECT thread_id FROM conversation_search_semantic_processing_threads)
        `;
        messages = yield* sql<SearchableConversationMessage>`
          SELECT
            thread.thread_id AS "threadId",
            thread.title,
            project.title AS "projectTitle",
            thread.branch,
            message.message_id AS "messageId",
            message.role,
            message.text
          FROM conversation_search_semantic_processing_threads AS processing
          JOIN projection_threads AS thread ON thread.thread_id = processing.thread_id
          JOIN projection_projects AS project ON project.project_id = thread.project_id
          JOIN projection_thread_messages AS message ON message.thread_id = thread.thread_id
          WHERE message.is_streaming = 0
            AND thread.deleted_at IS NULL
            AND project.deleted_at IS NULL
          ORDER BY thread.thread_id ASC, message.created_at ASC, message.message_id ASC
        `;
      }),
    );
    if (claimedThreadIds.length === 0) {
      semanticStatus = "ready";
      semanticBuildStarted = false;
      return false;
    }
    semanticStatus = "indexing";
    const chunks = buildConversationSearchChunks(messages);
    const nextChunks: LoadedSemanticChunk[] = [];
    for (let offset = 0; offset < chunks.length; offset += SEMANTIC_BATCH_SIZE) {
      const batch = chunks.slice(offset, offset + SEMANTIC_BATCH_SIZE);
      const embeddings = yield* embedTexts(
        batch.map((chunk) => chunk.text),
        "document",
      );
      batch.forEach((chunk, index) => {
        const embedding = embeddings[index];
        if (embedding?.length === CONVERSATION_SEARCH_DIMENSIONS) {
          nextChunks.push({ ...chunk, embedding });
        }
      });
      yield* Effect.yieldNow;
    }

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          DELETE FROM conversation_search_semantic_chunks
          WHERE thread_id IN (SELECT thread_id FROM conversation_search_semantic_processing_threads)
        `;
        yield* Effect.forEach(
          nextChunks,
          (chunk) =>
            sql`
              INSERT INTO conversation_search_semantic_chunks (
                chunk_id,
                thread_id,
                model,
                dimensions,
                source_fingerprint,
                text,
                embedding
              ) VALUES (
                ${chunk.chunkId},
                ${chunk.threadId},
                ${CONVERSATION_SEARCH_MODEL},
                ${CONVERSATION_SEARCH_DIMENSIONS},
                ${SEMANTIC_INDEX_FORMAT},
                ${chunk.text},
                ${toEmbeddingBytes(chunk.embedding)}
              )
            `,
          { concurrency: 1, discard: true },
        );
        yield* sql`
          INSERT INTO conversation_search_semantic_state (
            singleton,
            model,
            source_fingerprint,
            indexed_at
          ) VALUES (1, ${CONVERSATION_SEARCH_MODEL}, ${SEMANTIC_INDEX_FORMAT}, CURRENT_TIMESTAMP)
          ON CONFLICT (singleton) DO UPDATE SET
            model = excluded.model,
            source_fingerprint = excluded.source_fingerprint,
            indexed_at = excluded.indexed_at
        `;
        yield* sql`DELETE FROM conversation_search_semantic_processing_threads`;
      }),
    );
    const claimedThreadIdSet = new Set(claimedThreadIds);
    semanticChunks = [
      ...semanticChunks.filter((chunk) => !claimedThreadIdSet.has(chunk.threadId)),
      ...nextChunks,
    ];
    semanticBuildStarted = false;
    return true;
  });

  const semanticFailure = (cause: unknown) =>
    Effect.gen(function* () {
      semanticStatus = "unavailable";
      semanticBuildStarted = false;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT OR IGNORE INTO conversation_search_semantic_dirty_threads(thread_id)
            SELECT thread_id FROM conversation_search_semantic_processing_threads
          `;
          yield* sql`DELETE FROM conversation_search_semantic_processing_threads`;
        }),
      );
      yield* Effect.logWarning(
        "Conversation semantic search is unavailable; lexical search remains active",
        { cause },
      );
      yield* Effect.sleep("30 seconds");
    });
  const semanticCycle = rebuildDirtyThreads().pipe(
    Effect.flatMap((didWork) => Effect.sleep(didWork ? "100 millis" : "2 seconds")),
    Effect.catch(semanticFailure),
  );
  const semanticStartup = Effect.sleep("1 second").pipe(
    Effect.andThen(loadPersistedSemanticChunks()),
    Effect.andThen(Effect.forever(semanticCycle)),
    Effect.catch(semanticFailure),
  );
  yield* Effect.forkDetach(semanticStartup);

  const searchMetadata = Effect.fn("ConversationSearch.searchMetadata")(function* (
    query: string,
    includeArchived: boolean,
    candidateLimit: number,
  ) {
    const rows = yield* sql<ThreadMetadataRow>`
      SELECT
        thread.thread_id AS "threadId",
        thread.project_id AS "projectId",
        thread.title,
        project.title AS "projectTitle",
        thread.branch,
        thread.archived_at AS "archivedAt",
        thread.updated_at AS "updatedAt",
        CASE
          WHEN lower(thread.title) = lower(${query}) THEN 5
          WHEN lower(thread.title) LIKE lower(${`${query}%`}) THEN 4
          WHEN instr(lower(thread.title), lower(${query})) > 0 THEN 3
          WHEN instr(lower(project.title), lower(${query})) > 0 THEN 2
          ELSE 1
        END AS "metadataRank"
      FROM projection_threads AS thread
      JOIN projection_projects AS project ON project.project_id = thread.project_id
      WHERE thread.deleted_at IS NULL
        AND project.deleted_at IS NULL
        AND (${includeArchived ? 1 : 0} = 1 OR thread.archived_at IS NULL)
        AND (
          instr(lower(thread.title), lower(${query})) > 0
          OR instr(lower(project.title), lower(${query})) > 0
          OR instr(lower(COALESCE(thread.branch, '')), lower(${query})) > 0
        )
      ORDER BY "metadataRank" DESC, thread.updated_at DESC
      LIMIT ${candidateLimit}
    `;
    return rows.map(
      (row, index): BandedThreadSearchResult => ({
        ...toBaseResult(row),
        snippet: null,
        matchedRole: null,
        matchKind: "metadata",
        // Matching the thread's own title is a different claim from matching the
        // project it happens to live in, which every sibling thread matches too.
        band: row.metadataRank >= 3 ? THREAD_SEARCH_BAND.title : THREAD_SEARCH_BAND.metadata,
        score: 1_100 + row.metadataRank * 20 - index,
      }),
    );
  });

  const runContentQuery = Effect.fn("ConversationSearch.runContentQuery")(function* (
    ftsQuery: string,
    includeArchived: boolean,
    candidateLimit: number,
  ) {
    return yield* sql<ContentSearchRow>`
      SELECT
        thread.thread_id AS "threadId",
        thread.project_id AS "projectId",
        thread.title,
        project.title AS "projectTitle",
        thread.branch,
        thread.archived_at AS "archivedAt",
        thread.updated_at AS "updatedAt",
        message.role,
        message.text,
        snippet(projection_thread_messages_fts, 0, '', '', '…', 28) AS snippet,
        bm25(projection_thread_messages_fts) AS "ftsRank"
      FROM projection_thread_messages_fts
      JOIN projection_thread_messages AS message
        ON message.rowid = projection_thread_messages_fts.rowid
      JOIN projection_threads AS thread ON thread.thread_id = message.thread_id
      JOIN projection_projects AS project ON project.project_id = thread.project_id
      WHERE projection_thread_messages_fts MATCH ${ftsQuery}
        AND thread.deleted_at IS NULL
        AND project.deleted_at IS NULL
        AND (${includeArchived ? 1 : 0} = 1 OR thread.archived_at IS NULL)
      ORDER BY "ftsRank" ASC, message.created_at DESC
      LIMIT ${candidateLimit}
    `;
  });

  const searchContent = Effect.fn("ConversationSearch.searchContent")(function* (
    query: string,
    includeArchived: boolean,
    candidateLimit: number,
  ) {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    let rows = yield* runContentQuery(ftsQuery, includeArchived, candidateLimit);
    let loose = false;
    if (rows.length === 0) {
      // Nothing matched every term. Rather than report the conversation as
      // absent — which is what the orchestrator would tell the user — try again
      // for threads matching any of them, ranked by how many they hit.
      const relaxed = relaxFtsQuery(ftsQuery);
      if (relaxed !== null) {
        rows = yield* runContentQuery(relaxed, includeArchived, candidateLimit);
        loose = rows.length > 0;
      }
    }
    const seenThreadIds = new Set<string>();
    const results: BandedThreadSearchResult[] = [];
    for (const row of rows) {
      if (seenThreadIds.has(row.threadId)) continue;
      seenThreadIds.add(row.threadId);
      const exactPhrase = row.text.toLowerCase().includes(query.toLowerCase());
      results.push({
        ...toBaseResult(row),
        snippet: row.snippet,
        matchedRole: messageRole(row.role),
        matchKind: loose ? "content-loose" : "content",
        band: loose ? THREAD_SEARCH_BAND.loose : THREAD_SEARCH_BAND.content,
        score:
          (loose ? LOOSE_CONTENT_BASE_SCORE : STRICT_CONTENT_BASE_SCORE) +
          (exactPhrase ? 80 : 0) +
          (row.role === "user" ? 25 : 0) -
          results.length,
      });
    }
    return results;
  });

  /**
   * Literal substring search, the "does this string appear anywhere" question.
   *
   * A plain scan rather than an index lookup: the message text is small (tens of
   * MB) next to the activity log this database is mostly made of, and `instr`
   * over all of it measures faster than the FTS path it replaces, because there
   * is no doclist intersection or bm25 pass. Nothing here is ranked — every row
   * genuinely contains the string, so recency is the only ordering left that
   * means anything.
   */
  const searchExact = Effect.fn("ConversationSearch.searchExact")(function* (
    query: string,
    includeArchived: boolean,
    limit: number,
  ) {
    // Smart case, as in ripgrep: an all-lowercase query is a casual one and
    // matches either way, while any capital is taken as deliberate. Searching
    // `ThreadId` should not drag in every `threadId`.
    const caseSensitive = query !== query.toLowerCase();
    // `instr` decides every result either way. The trigram index only narrows
    // which rows get that check, so its two blind spots — queries under three
    // characters, and its case-insensitivity — cost speed rather than accuracy.
    const useTrigram = query.length >= TRIGRAM_MIN_QUERY_CHARS;
    const rows = yield* sql<ExactSearchRow>`
      SELECT
        thread.thread_id AS "threadId",
        thread.project_id AS "projectId",
        thread.title,
        project.title AS "projectTitle",
        thread.branch,
        thread.archived_at AS "archivedAt",
        thread.updated_at AS "updatedAt",
        message.role,
        CASE
          WHEN ${caseSensitive ? 1 : 0} = 1 THEN instr(message.text, ${query})
          ELSE instr(lower(message.text), lower(${query}))
        END AS "matchOffset",
        message.text,
        message.created_at AS "createdAt"
      FROM projection_thread_messages AS message
      JOIN projection_threads AS thread ON thread.thread_id = message.thread_id
      JOIN projection_projects AS project ON project.project_id = thread.project_id
      WHERE message.is_streaming = 0
        AND thread.deleted_at IS NULL
        AND project.deleted_at IS NULL
        AND (${includeArchived ? 1 : 0} = 1 OR thread.archived_at IS NULL)
        AND (
          ${useTrigram ? 1 : 0} = 0
          OR message.rowid IN (
            SELECT rowid FROM projection_thread_messages_trigram
            WHERE projection_thread_messages_trigram MATCH ${toTrigramMatch(query)}
          )
        )
        AND "matchOffset" > 0
      ORDER BY message.created_at DESC
      LIMIT ${limit * EXACT_CANDIDATE_MULTIPLIER}
    `;

    const seenThreadIds = new Set<string>();
    const results: BandedThreadSearchResult[] = [];
    for (const row of rows) {
      if (results.length >= limit) break;
      if (seenThreadIds.has(row.threadId)) continue;
      seenThreadIds.add(row.threadId);
      results.push({
        ...toBaseResult(row),
        snippet: exactSnippet(row.text, row.matchOffset),
        matchedRole: messageRole(row.role),
        matchKind: "exact",
        band: THREAD_SEARCH_BAND.exact,
        score: EXACT_BASE_SCORE - results.length,
      });
    }
    return results;
  });

  const searchSemantic = Effect.fn("ConversationSearch.searchSemantic")(function* (
    query: string,
    includeArchived: boolean,
    candidateLimit: number,
  ) {
    if (semanticStatus !== "ready" || semanticChunks.length === 0) return [];
    const [queryEmbedding] = yield* embedTexts([query], "query");
    if (!queryEmbedding) return [];
    const threadRows = yield* sql<SemanticThreadMetadataRow>`
      SELECT
        thread.thread_id AS "threadId",
        thread.project_id AS "projectId",
        thread.title,
        project.title AS "projectTitle",
        thread.branch,
        thread.archived_at AS "archivedAt",
        thread.updated_at AS "updatedAt"
      FROM projection_threads AS thread
      JOIN projection_projects AS project ON project.project_id = thread.project_id
      WHERE thread.deleted_at IS NULL
        AND project.deleted_at IS NULL
        AND (${includeArchived ? 1 : 0} = 1 OR thread.archived_at IS NULL)
    `;
    const metadataByThreadId = new Map(threadRows.map((row) => [row.threadId, row] as const));
    const scoredChunks = semanticChunks
      .map((chunk) => ({ chunk, similarity: dotProduct(queryEmbedding, chunk.embedding) }))
      .toSorted((left, right) => right.similarity - left.similarity);
    // Scored before it is filtered: the cut-off is a fraction of the best match
    // this query found, so there is nothing to compare against until it is.
    const floor = semanticSimilarityFloor(scoredChunks[0]?.similarity ?? 0);
    const rankedChunks = scoredChunks.filter((entry) => entry.similarity >= floor);
    const threadLimit = Math.min(candidateLimit, MAX_SEMANTIC_THREADS);
    const seenThreadIds = new Set<string>();
    const results: BandedThreadSearchResult[] = [];
    for (const entry of rankedChunks) {
      if (results.length >= threadLimit) break;
      if (seenThreadIds.has(entry.chunk.threadId)) continue;
      const metadata = metadataByThreadId.get(entry.chunk.threadId);
      if (!metadata) continue;
      seenThreadIds.add(entry.chunk.threadId);
      results.push({
        ...toBaseResult(metadata),
        snippet: semanticSnippet(entry.chunk.text),
        matchedRole: null,
        matchKind: "semantic",
        band: THREAD_SEARCH_BAND.semantic,
        score: entry.similarity * 500,
      });
    }
    return results;
  });

  const isConversationSearchError = Schema.is(ConversationSearchError);
  const search: ConversationSearchShape["search"] = Effect.fn("ConversationSearch.search")(
    function* (input) {
      const query = input.query.trim();
      const limit = clampLimit(input.limit);
      const includeArchived = input.includeArchived ?? true;

      // Exact mode returns only verbatim hits — no keyword fallback, no
      // semantic pass. Blending in approximate matches would destroy the one
      // thing it is for: an empty result that can be believed.
      if (input.exact === true) {
        return {
          results: toOrderedThreadSearchResults(yield* searchExact(query, includeArchived, limit)),
          semanticStatus,
        } satisfies OrchestrationSearchThreadsResult;
      }

      const candidateLimit = Math.min(
        MAX_SEARCH_RESULTS * 4,
        limit * SEMANTIC_CANDIDATE_MULTIPLIER,
      );
      const [metadata, content] = yield* Effect.all(
        [
          searchMetadata(query, includeArchived, candidateLimit),
          searchContent(query, includeArchived, candidateLimit),
        ],
        { concurrency: "unbounded" },
      );
      const semantic =
        input.includeSemantic === false
          ? []
          : yield* searchSemantic(query, includeArchived, candidateLimit).pipe(
              Effect.timeoutOption(SEMANTIC_QUERY_BUDGET),
              Effect.catch((cause) =>
                Effect.logWarning(
                  "Semantic query ranking failed; returning lexical conversation search results",
                  { cause },
                ).pipe(Effect.as(Option.none())),
              ),
              Effect.map(Option.getOrElse(() => [])),
            );
      return {
        results: toOrderedThreadSearchResults(
          mergeHybridThreadSearchResults({
            lexical: mergeHybridThreadSearchResults({
              lexical: metadata,
              semantic: content,
              limit: candidateLimit,
            }),
            semantic,
            limit,
          }),
        ),
        semanticStatus,
      } satisfies OrchestrationSearchThreadsResult;
    },
    Effect.mapError((cause) =>
      isConversationSearchError(cause)
        ? cause
        : new ConversationSearchError({ message: "Conversation search failed.", cause }),
    ),
  );

  return ConversationSearch.of({ search });
});

export const ConversationSearchLive = Layer.effect(ConversationSearch, makeConversationSearch);
