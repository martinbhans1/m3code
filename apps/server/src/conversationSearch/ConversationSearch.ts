import {
  MessageId,
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
import { readerOr } from "../persistence/SqliteReadWorker.ts";
import { makeLocalEmbedder } from "./LocalEmbedder.ts";
import {
  buildConversationSearchChunks,
  buildFtsQuery,
  CONVERSATION_SEARCH_DIMENSIONS,
  CONVERSATION_SEARCH_MODEL,
  dotProduct,
  fromEmbeddingBytes,
  MAX_SEMANTIC_THREADS,
  makeThreadMetadataRanker,
  mergeHybridThreadSearchResults,
  planSemanticReindex,
  querySearchWords,
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
/**
 * Chunks per model call while indexing. A search's query embedding waits for the
 * batch already running, so this bounds how stale the semantic results get while
 * the indexer is busy: about 0.15s of model time per chunk.
 */
const SEMANTIC_BATCH_SIZE = 8;
const SEMANTIC_DIRTY_THREAD_BATCH_SIZE = 50;
/** Index rows per read when loading the semantic index at startup. */
const SEMANTIC_LOAD_PAGE_SIZE = 2_000;
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
}

interface ContentSearchRow extends ThreadMetadataRow {
  readonly messageId: string;
  readonly role: string;
  readonly text: string;
}

interface ExactSearchRow extends ThreadMetadataRow {
  readonly messageId: string;
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
  readonly embedding: Uint8Array;
}

interface StoredChunkRow {
  readonly chunkId: string;
  readonly text: string;
  readonly embedding: Uint8Array;
  /** 1 when the row was embedded by the current model and index format. */
  readonly current: number;
}

interface ChunkTextRow {
  readonly chunkId: string;
  readonly text: string;
}

interface SemanticThreadMetadataRow extends ThreadMetadataRow {}

/**
 * One chunk of the in-memory semantic index. The chunk's text stays in the
 * database: ranking needs only the vector, and the handful of chunks that make it
 * into the results have their text read for the snippet.
 */
interface LoadedSemanticChunk {
  readonly chunkId: string;
  readonly threadId: string;
  readonly embedding: Float32Array;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || limit <= 0) return DEFAULT_SEARCH_RESULTS;
  return Math.min(MAX_SEARCH_RESULTS, Math.trunc(limit));
}

function messageRole(value: string): "user" | "assistant" | "system" | null {
  return value === "user" || value === "assistant" || value === "system" ? value : null;
}

function toBaseResult(
  row: SemanticThreadMetadataRow,
): Omit<
  OrchestrationThreadSearchResult,
  "matchKind" | "score" | "snippet" | "matchedRole" | "matchedMessageId"
> {
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

/**
 * A window around the first search word in a keyword hit. Built here rather than
 * by FTS5's `snippet()`, which has to be evaluated for every candidate row and so
 * reads the full text of every message the index matched, not just the ones shown.
 */
function keywordSnippet(text: string, query: string): string {
  const haystack = text.toLowerCase();
  const offsets = querySearchWords(query)
    .map((word) => haystack.indexOf(word))
    .filter((offset) => offset >= 0);
  return exactSnippet(text, offsets.length > 0 ? Math.min(...offsets) + 1 : 1);
}

function semanticSnippet(text: string): string {
  const withoutMetadata = text.replace(/^(?:Title|Project|Branch):.*\n/gmu, "").trim();
  return withoutMetadata.length <= 280 ? withoutMetadata : `${withoutMetadata.slice(0, 277)}…`;
}

const makeConversationSearch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Heavy reads — message text scans, whole-thread reads for the indexer, the
  // index load — go to a read-only connection on its own thread when the server
  // has one, so they no longer hold the event loop. Anything that must see its
  // own uncommitted writes stays on `sql`.
  const reader = yield* readerOr(sql);
  const config = yield* ServerConfig;

  let semanticStatus: OrchestrationSearchThreadsResult["semanticStatus"] = "indexing";
  let semanticChunks: ReadonlyArray<LoadedSemanticChunk> = [];
  /**
   * The persisted index is in memory. Until then there is nothing to rank
   * against; after it, semantic search answers even while the indexer catches up
   * — from vectors at most one indexing cycle old for the threads it is busy
   * with — rather than going dark whenever any conversation is active.
   */
  let semanticIndexLoaded = false;
  let semanticBuildStarted = false;
  const embedder = yield* Effect.acquireRelease(
    Effect.sync(() =>
      makeLocalEmbedder({
        model: "Xenova/bge-small-en-v1.5",
        dtype: "q8",
        cacheDir: `${config.providerStatusCacheDir}/conversation-search-models`,
      }),
    ),
    (embedder) => Effect.promise(() => embedder.close()),
  );

  const embedTexts = Effect.fn("ConversationSearch.embedTexts")(function* (
    texts: ReadonlyArray<string>,
    kind: "query" | "document",
  ) {
    const prefixedTexts =
      kind === "query"
        ? texts.map((text) => `Represent this sentence for searching relevant passages: ${text}`)
        : texts;
    return yield* Effect.tryPromise({
      try: () => embedder.embed(prefixedTexts, kind),
      catch: (cause) =>
        new ConversationSearchError({ message: "Local embedding inference failed.", cause }),
    });
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
      // Paged, so no single read or decode holds the server for long: tens of
      // thousands of rows in one statement froze it for seconds at startup.
      const loaded: LoadedSemanticChunk[] = [];
      let after = "";
      while (true) {
        const rows = yield* reader<SemanticChunkRow>`
          SELECT chunk_id AS "chunkId", thread_id AS "threadId", embedding
          FROM conversation_search_semantic_chunks
          WHERE chunk_id > ${after}
            AND model = ${CONVERSATION_SEARCH_MODEL}
            AND dimensions = ${CONVERSATION_SEARCH_DIMENSIONS}
            AND source_fingerprint = ${SEMANTIC_INDEX_FORMAT}
          ORDER BY chunk_id ASC
          LIMIT ${SEMANTIC_LOAD_PAGE_SIZE}
        `;
        for (const row of rows) {
          loaded.push({
            chunkId: row.chunkId,
            threadId: row.threadId,
            embedding: fromEmbeddingBytes(row.embedding),
          });
        }
        if (rows.length < SEMANTIC_LOAD_PAGE_SIZE) break;
        after = rows.at(-1)!.chunkId;
        yield* Effect.yieldNow;
      }
      semanticChunks = loaded;
      semanticIndexLoaded = true;
    },
  );

  const rebuildDirtyThreads = Effect.fn("ConversationSearch.rebuildDirtyThreads")(function* () {
    if (semanticBuildStarted) return false;
    semanticBuildStarted = true;
    let claimedThreadIds: ReadonlyArray<string> = [];
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
      }),
    );
    if (claimedThreadIds.length === 0) {
      semanticStatus = "ready";
      semanticBuildStarted = false;
      return false;
    }
    semanticStatus = "indexing";
    // Read outside the claim, on the reader: a long thread is megabytes of text
    // and its stored chunks as much again, read every time it gets a message. A
    // message landing after the claim marks the thread dirty again, so the next
    // cycle picks it up — the same guarantee the claim always gave.
    const messages = yield* reader<SearchableConversationMessage>`
      SELECT
        thread.thread_id AS "threadId",
        thread.title,
        project.title AS "projectTitle",
        thread.branch,
        message.message_id AS "messageId",
        message.role,
        message.text
      FROM projection_threads AS thread
      JOIN projection_projects AS project ON project.project_id = thread.project_id
      JOIN projection_thread_messages AS message ON message.thread_id = thread.thread_id
      WHERE thread.thread_id IN ${reader.in(claimedThreadIds)}
        AND message.is_streaming = 0
        AND thread.deleted_at IS NULL
        AND project.deleted_at IS NULL
      ORDER BY thread.thread_id ASC, message.created_at ASC, message.message_id ASC
    `;
    const storedChunks = yield* reader<StoredChunkRow>`
      SELECT
        chunk_id AS "chunkId",
        text,
        embedding,
        (
          model = ${CONVERSATION_SEARCH_MODEL}
          AND dimensions = ${CONVERSATION_SEARCH_DIMENSIONS}
          AND source_fingerprint = ${SEMANTIC_INDEX_FORMAT}
        ) AS "current"
      FROM conversation_search_semantic_chunks
      WHERE thread_id IN ${reader.in(claimedThreadIds)}
    `;
    // Only embed what changed (see `planSemanticReindex`). Stored rows are the
    // reference, not memory, so another backend sharing the database cannot leave
    // this one trusting an embedding that is not there.
    const plan = planSemanticReindex(
      buildConversationSearchChunks(messages),
      storedChunks.map((row) => ({
        chunkId: row.chunkId,
        text: row.text,
        current: row.current === 1,
      })),
    );
    const storedEmbeddingById = new Map(
      storedChunks.map((row) => [row.chunkId, row.embedding] as const),
    );
    const reusedChunks: LoadedSemanticChunk[] = plan.reuse.map((chunk) => ({
      chunkId: chunk.chunkId,
      threadId: chunk.threadId,
      embedding: fromEmbeddingBytes(storedEmbeddingById.get(chunk.chunkId)!),
    }));
    const chunksToEmbed = plan.embed;
    const staleChunkIds = plan.staleChunkIds;
    const embeddedChunks: Array<{ chunk: ConversationSearchChunk; embedding: Float32Array }> = [];
    for (let offset = 0; offset < chunksToEmbed.length; offset += SEMANTIC_BATCH_SIZE) {
      const batch = chunksToEmbed.slice(offset, offset + SEMANTIC_BATCH_SIZE);
      const embeddings = yield* embedTexts(
        batch.map((chunk) => chunk.text),
        "document",
      );
      batch.forEach((chunk, index) => {
        const embedding = embeddings[index];
        if (embedding?.length === CONVERSATION_SEARCH_DIMENSIONS) {
          embeddedChunks.push({ chunk, embedding });
        }
      });
    }

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* Effect.forEach(
          staleChunkIds,
          (chunkId) =>
            sql`DELETE FROM conversation_search_semantic_chunks WHERE chunk_id = ${chunkId}`,
          { concurrency: 1, discard: true },
        );
        yield* Effect.forEach(
          embeddedChunks,
          ({ chunk, embedding }) =>
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
                ${toEmbeddingBytes(embedding)}
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
      ...reusedChunks,
      ...embeddedChunks.map(({ chunk, embedding }) => ({
        chunkId: chunk.chunkId,
        threadId: chunk.threadId,
        embedding,
      })),
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
    updatedSince: string | null,
  ) {
    // Every live thread's labels, ranked in JS: a few thousand short rows read in
    // milliseconds, and word-by-word title matching is awkward to express in SQL.
    const rankThread = makeThreadMetadataRanker(query);
    const rows = yield* reader<ThreadMetadataRow>`
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
        AND (${updatedSince} IS NULL OR thread.updated_at >= ${updatedSince})
      ORDER BY thread.updated_at DESC
    `;
    return rows
      .map((row) => ({ row, rank: rankThread(row) }))
      .filter((entry) => entry.rank > 0)
      .toSorted((left, right) => right.rank - left.rank)
      .slice(0, candidateLimit)
      .map(
        ({ row, rank }, index): BandedThreadSearchResult => ({
          ...toBaseResult(row),
          snippet: null,
          matchedRole: null,
          matchedMessageId: null,
          matchKind: "metadata",
          // Matching the thread's own title is a different claim from matching the
          // project it happens to live in, which every sibling thread matches too.
          band: rank >= 3 ? THREAD_SEARCH_BAND.title : THREAD_SEARCH_BAND.metadata,
          score: 1_100 + rank * 20 - index,
        }),
      );
  });

  const runContentQuery = Effect.fn("ConversationSearch.runContentQuery")(function* (
    ftsQuery: string,
    includeArchived: boolean,
    candidateLimit: number,
    updatedSince: string | null,
  ) {
    // Rank first, read text after. A common word matches thousands of messages,
    // and anything the ranking step selects is read for every one of them — text,
    // or any column stored after it, means paging through the whole message body.
    // On a cold cache that turned one keystroke into a 30-second stall of the
    // entire server, since SQLite runs on its thread. Ranking needs only the index
    // and `thread_id`, which sits ahead of the text, so only the rows that make the
    // cut have their text read. Rowid stands in for creation order as tiebreak.
    return yield* reader<ContentSearchRow>`
      WITH ranked AS (
        SELECT
          projection_thread_messages_fts.rowid AS "hitRowid",
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
          AND (${updatedSince} IS NULL OR thread.updated_at >= ${updatedSince})
        ORDER BY "ftsRank" ASC, projection_thread_messages_fts.rowid DESC
        LIMIT ${candidateLimit}
      )
      SELECT
        thread.thread_id AS "threadId",
        thread.project_id AS "projectId",
        thread.title,
        project.title AS "projectTitle",
        thread.branch,
        thread.archived_at AS "archivedAt",
        thread.updated_at AS "updatedAt",
        message.message_id AS "messageId",
        message.role,
        message.text
      FROM ranked
      CROSS JOIN projection_thread_messages AS message ON message.rowid = ranked."hitRowid"
      JOIN projection_threads AS thread ON thread.thread_id = message.thread_id
      JOIN projection_projects AS project ON project.project_id = thread.project_id
      ORDER BY ranked."ftsRank" ASC, ranked."hitRowid" DESC
    `;
  });

  const searchContent = Effect.fn("ConversationSearch.searchContent")(function* (
    query: string,
    includeArchived: boolean,
    candidateLimit: number,
    updatedSince: string | null,
  ) {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    let rows = yield* runContentQuery(ftsQuery, includeArchived, candidateLimit, updatedSince);
    let loose = false;
    if (rows.length === 0) {
      // Nothing matched every term. Rather than report the conversation as
      // absent — which is what the orchestrator would tell the user — try again
      // for threads matching any of them, ranked by how many they hit.
      const relaxed = relaxFtsQuery(ftsQuery);
      if (relaxed !== null) {
        rows = yield* runContentQuery(relaxed, includeArchived, candidateLimit, updatedSince);
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
        snippet: keywordSnippet(row.text, query),
        matchedRole: messageRole(row.role),
        matchedMessageId: MessageId.make(row.messageId),
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
    updatedSince: string | null,
  ) {
    // Smart case, as in ripgrep: an all-lowercase query is a casual one and
    // matches either way, while any capital is taken as deliberate. Searching
    // `ThreadId` should not drag in every `threadId`.
    const caseSensitive = query !== query.toLowerCase();
    // `instr` decides every result either way. The trigram index only narrows
    // which rows get that check, so its two blind spots — queries under three
    // characters, and its case-insensitivity — cost speed rather than accuracy.
    const useTrigram = query.length >= TRIGRAM_MIN_QUERY_CHARS;
    const rows = yield* reader<ExactSearchRow>`
      SELECT
        thread.thread_id AS "threadId",
        thread.project_id AS "projectId",
        thread.title,
        project.title AS "projectTitle",
        thread.branch,
        thread.archived_at AS "archivedAt",
        thread.updated_at AS "updatedAt",
        message.message_id AS "messageId",
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
        AND (${updatedSince} IS NULL OR thread.updated_at >= ${updatedSince})
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
        matchedMessageId: MessageId.make(row.messageId),
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
    updatedSince: string | null,
  ) {
    if (!semanticIndexLoaded || semanticChunks.length === 0) return [];
    const threadRows = yield* reader<SemanticThreadMetadataRow>`
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
        AND (${updatedSince} IS NULL OR thread.updated_at >= ${updatedSince})
    `;
    if (threadRows.length === 0) return [];
    const [queryEmbedding] = yield* embedTexts([query], "query");
    if (!queryEmbedding) return [];
    const metadataByThreadId = new Map(threadRows.map((row) => [row.threadId, row] as const));
    const scoredChunks = semanticChunks
      .filter((chunk) => metadataByThreadId.has(chunk.threadId))
      .map((chunk) => ({ chunk, similarity: dotProduct(queryEmbedding, chunk.embedding) }))
      .toSorted((left, right) => right.similarity - left.similarity);
    // Scored before it is filtered: the cut-off is a fraction of the best match
    // this query found, so there is nothing to compare against until it is.
    const floor = semanticSimilarityFloor(scoredChunks[0]?.similarity ?? 0);
    const rankedChunks = scoredChunks.filter((entry) => entry.similarity >= floor);
    const threadLimit = Math.min(candidateLimit, MAX_SEMANTIC_THREADS);
    const seenThreadIds = new Set<string>();
    const picked: Array<{ entry: (typeof rankedChunks)[number]; metadata: ThreadMetadataRow }> = [];
    for (const entry of rankedChunks) {
      if (picked.length >= threadLimit) break;
      if (seenThreadIds.has(entry.chunk.threadId)) continue;
      const metadata = metadataByThreadId.get(entry.chunk.threadId);
      if (!metadata) continue;
      seenThreadIds.add(entry.chunk.threadId);
      picked.push({ entry, metadata });
    }
    if (picked.length === 0) return [];
    const textByChunkId = new Map(
      (yield* reader<ChunkTextRow>`
        SELECT chunk_id AS "chunkId", text
        FROM conversation_search_semantic_chunks
        WHERE chunk_id IN ${reader.in(picked.map(({ entry }) => entry.chunk.chunkId))}
      `).map((row) => [row.chunkId, row.text] as const),
    );
    const results: BandedThreadSearchResult[] = [];
    for (const { entry, metadata } of picked) {
      const text = textByChunkId.get(entry.chunk.chunkId);
      results.push({
        ...toBaseResult(metadata),
        snippet: text === undefined ? null : semanticSnippet(text),
        matchedRole: null,
        // A chunk spans several messages, so there is no one message to point
        // at. Reporting the first would be a guess, and the caller would read
        // the wrong place with full confidence.
        matchedMessageId: null,
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
      const updatedSince = input.updatedSince ?? null;

      // Exact mode returns only verbatim hits — no keyword fallback, no
      // semantic pass. Blending in approximate matches would destroy the one
      // thing it is for: an empty result that can be believed.
      if (input.exact === true) {
        return {
          results: toOrderedThreadSearchResults(
            yield* searchExact(query, includeArchived, limit, updatedSince),
          ),
          semanticStatus,
        } satisfies OrchestrationSearchThreadsResult;
      }

      // Titles, project names and branches only: one short read, no message text
      // and no embedding, so it answers on every keystroke.
      if (input.titlesOnly === true) {
        return {
          results: toOrderedThreadSearchResults(
            yield* searchMetadata(query, includeArchived, limit, updatedSince),
          ),
          semanticStatus,
        } satisfies OrchestrationSearchThreadsResult;
      }

      const candidateLimit = Math.min(
        MAX_SEARCH_RESULTS * 4,
        limit * SEMANTIC_CANDIDATE_MULTIPLIER,
      );
      const [metadata, content] = yield* Effect.all(
        [
          searchMetadata(query, includeArchived, candidateLimit, updatedSince),
          searchContent(query, includeArchived, candidateLimit, updatedSince),
        ],
        { concurrency: "unbounded" },
      );
      const semantic =
        input.includeSemantic === false
          ? []
          : yield* searchSemantic(query, includeArchived, candidateLimit, updatedSince).pipe(
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
