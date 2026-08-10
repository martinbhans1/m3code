import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * SQLite applies the conflict policy of an outer INSERT ... ON CONFLICT
 * statement to INSERT OR IGNORE statements executed by its triggers. Projection
 * repositories use upserts, so migration 035's dirty-thread triggers could throw
 * on an already-dirty thread and roll back the projection update.
 *
 * Recreate the triggers with an explicit UPSERT clause. Unlike OR IGNORE, the
 * inner ON CONFLICT clause remains authoritative when the trigger is invoked by
 * an outer upsert.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TRIGGER IF EXISTS conversation_search_semantic_message_after_insert`;
  yield* sql`DROP TRIGGER IF EXISTS conversation_search_semantic_message_before_delete`;
  yield* sql`DROP TRIGGER IF EXISTS conversation_search_semantic_message_after_update`;
  yield* sql`DROP TRIGGER IF EXISTS conversation_search_semantic_thread_after_insert`;
  yield* sql`DROP TRIGGER IF EXISTS conversation_search_semantic_thread_before_delete`;
  yield* sql`DROP TRIGGER IF EXISTS conversation_search_semantic_thread_after_update`;
  yield* sql`DROP TRIGGER IF EXISTS conversation_search_semantic_project_after_update`;

  yield* sql`
    CREATE TRIGGER conversation_search_semantic_message_after_insert
    AFTER INSERT ON projection_thread_messages
    WHEN new.is_streaming = 0
    BEGIN
      INSERT INTO conversation_search_semantic_dirty_threads(thread_id)
      VALUES (new.thread_id)
      ON CONFLICT(thread_id) DO NOTHING;
    END
  `;

  yield* sql`
    CREATE TRIGGER conversation_search_semantic_message_before_delete
    BEFORE DELETE ON projection_thread_messages
    WHEN old.is_streaming = 0
    BEGIN
      INSERT INTO conversation_search_semantic_dirty_threads(thread_id)
      VALUES (old.thread_id)
      ON CONFLICT(thread_id) DO NOTHING;
    END
  `;

  yield* sql`
    CREATE TRIGGER conversation_search_semantic_message_after_update
    AFTER UPDATE ON projection_thread_messages
    WHEN new.text <> old.text
      OR new.is_streaming <> old.is_streaming
      OR new.thread_id <> old.thread_id
    BEGIN
      INSERT INTO conversation_search_semantic_dirty_threads(thread_id)
      VALUES (old.thread_id)
      ON CONFLICT(thread_id) DO NOTHING;
      INSERT INTO conversation_search_semantic_dirty_threads(thread_id)
      VALUES (new.thread_id)
      ON CONFLICT(thread_id) DO NOTHING;
    END
  `;

  yield* sql`
    CREATE TRIGGER conversation_search_semantic_thread_after_insert
    AFTER INSERT ON projection_threads
    BEGIN
      INSERT INTO conversation_search_semantic_dirty_threads(thread_id)
      VALUES (new.thread_id)
      ON CONFLICT(thread_id) DO NOTHING;
    END
  `;

  yield* sql`
    CREATE TRIGGER conversation_search_semantic_thread_before_delete
    BEFORE DELETE ON projection_threads
    BEGIN
      INSERT INTO conversation_search_semantic_dirty_threads(thread_id)
      VALUES (old.thread_id)
      ON CONFLICT(thread_id) DO NOTHING;
    END
  `;

  yield* sql`
    CREATE TRIGGER conversation_search_semantic_thread_after_update
    AFTER UPDATE ON projection_threads
    WHEN new.title <> old.title
      OR COALESCE(new.branch, '') <> COALESCE(old.branch, '')
      OR COALESCE(new.deleted_at, '') <> COALESCE(old.deleted_at, '')
    BEGIN
      INSERT INTO conversation_search_semantic_dirty_threads(thread_id)
      VALUES (new.thread_id)
      ON CONFLICT(thread_id) DO NOTHING;
    END
  `;

  yield* sql`
    CREATE TRIGGER conversation_search_semantic_project_after_update
    AFTER UPDATE ON projection_projects
    WHEN new.title <> old.title
      OR COALESCE(new.deleted_at, '') <> COALESCE(old.deleted_at, '')
    BEGIN
      INSERT INTO conversation_search_semantic_dirty_threads(thread_id)
      SELECT thread_id FROM projection_threads WHERE project_id = new.project_id
      ON CONFLICT(thread_id) DO NOTHING;
    END
  `;
});
