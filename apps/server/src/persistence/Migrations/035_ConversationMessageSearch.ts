import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Keep completed conversation messages in a compact FTS5 index. Streaming
 * assistant deltas are deliberately excluded so a long response does not
 * rewrite the search index on every token.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS projection_thread_messages_fts USING fts5(
      text,
      content = 'projection_thread_messages',
      content_rowid = 'rowid',
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_messages_fts(rowid, text)
    SELECT rowid, text
    FROM projection_thread_messages
    WHERE is_streaming = 0
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_fts_after_insert
    AFTER INSERT ON projection_thread_messages
    WHEN new.is_streaming = 0
    BEGIN
      INSERT INTO projection_thread_messages_fts(rowid, text)
      VALUES (new.rowid, new.text);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_fts_before_delete
    BEFORE DELETE ON projection_thread_messages
    WHEN old.is_streaming = 0
    BEGIN
      INSERT INTO projection_thread_messages_fts(
        projection_thread_messages_fts,
        rowid,
        text
      ) VALUES ('delete', old.rowid, old.text);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_fts_before_update
    BEFORE UPDATE ON projection_thread_messages
    WHEN old.is_streaming = 0
      AND (new.is_streaming <> old.is_streaming OR new.text <> old.text)
    BEGIN
      INSERT INTO projection_thread_messages_fts(
        projection_thread_messages_fts,
        rowid,
        text
      ) VALUES ('delete', old.rowid, old.text);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_fts_after_update
    AFTER UPDATE ON projection_thread_messages
    WHEN new.is_streaming = 0
      AND (new.is_streaming <> old.is_streaming OR new.text <> old.text)
    BEGIN
      INSERT INTO projection_thread_messages_fts(rowid, text)
      VALUES (new.rowid, new.text);
    END
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS conversation_search_semantic_chunks (
      chunk_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      source_fingerprint TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_conversation_search_semantic_chunks_thread
    ON conversation_search_semantic_chunks(thread_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS conversation_search_semantic_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      model TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS conversation_search_semantic_dirty_threads (
      thread_id TEXT PRIMARY KEY
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS conversation_search_semantic_processing_threads (
      thread_id TEXT PRIMARY KEY
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO conversation_search_semantic_dirty_threads(thread_id)
    SELECT thread.thread_id
    FROM projection_threads AS thread
    JOIN projection_projects AS project ON project.project_id = thread.project_id
    WHERE thread.deleted_at IS NULL AND project.deleted_at IS NULL
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS conversation_search_semantic_message_after_insert
    AFTER INSERT ON projection_thread_messages
    WHEN new.is_streaming = 0
    BEGIN
      INSERT OR IGNORE INTO conversation_search_semantic_dirty_threads(thread_id)
      VALUES (new.thread_id);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS conversation_search_semantic_message_before_delete
    BEFORE DELETE ON projection_thread_messages
    WHEN old.is_streaming = 0
    BEGIN
      INSERT OR IGNORE INTO conversation_search_semantic_dirty_threads(thread_id)
      VALUES (old.thread_id);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS conversation_search_semantic_message_after_update
    AFTER UPDATE ON projection_thread_messages
    WHEN new.text <> old.text
      OR new.is_streaming <> old.is_streaming
      OR new.thread_id <> old.thread_id
    BEGIN
      INSERT OR IGNORE INTO conversation_search_semantic_dirty_threads(thread_id)
      VALUES (old.thread_id);
      INSERT OR IGNORE INTO conversation_search_semantic_dirty_threads(thread_id)
      VALUES (new.thread_id);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS conversation_search_semantic_thread_after_insert
    AFTER INSERT ON projection_threads
    BEGIN
      INSERT OR IGNORE INTO conversation_search_semantic_dirty_threads(thread_id)
      VALUES (new.thread_id);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS conversation_search_semantic_thread_before_delete
    BEFORE DELETE ON projection_threads
    BEGIN
      INSERT OR IGNORE INTO conversation_search_semantic_dirty_threads(thread_id)
      VALUES (old.thread_id);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS conversation_search_semantic_thread_after_update
    AFTER UPDATE ON projection_threads
    WHEN new.title <> old.title
      OR COALESCE(new.branch, '') <> COALESCE(old.branch, '')
      OR COALESCE(new.deleted_at, '') <> COALESCE(old.deleted_at, '')
    BEGIN
      INSERT OR IGNORE INTO conversation_search_semantic_dirty_threads(thread_id)
      VALUES (new.thread_id);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS conversation_search_semantic_project_after_update
    AFTER UPDATE ON projection_projects
    WHEN new.title <> old.title
      OR COALESCE(new.deleted_at, '') <> COALESCE(old.deleted_at, '')
    BEGIN
      INSERT OR IGNORE INTO conversation_search_semantic_dirty_threads(thread_id)
      SELECT thread_id FROM projection_threads WHERE project_id = new.project_id;
    END
  `;
});
