import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Materializes the two ends of a thread handoff — the thread this conversation
 * was continued in, and the thread this one was spun off from — so the sidebar
 * can badge a handed-off thread and a spun-off thread can render a backlink
 * without loading either thread's activities.
 *
 * The columns are kept fresh by refreshThreadShellSummary (which already runs
 * on thread.activity-appended); this migration only has to create them and
 * backfill threads that already carry handoff activities.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("handoff_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN handoff_thread_id TEXT
    `;
  }

  if (!existing.has("source_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN source_thread_id TEXT
    `;
  }

  // The backfill recomputes both columns from the activity log for every
  // thread, which is exactly what refreshThreadShellSummary does at runtime, so
  // it is idempotent. Running it unconditionally rather than only when a column
  // was just added means a run that dies between the ALTER and the UPDATE is
  // repaired by the next one instead of permanently skipping the backfill.
  //
  // Handoffs are event-sourced: each one appends a thread.handoff activity
  // carrying the whole record, and the latest per direction wins. Order by
  // created_at (NOT sequence — buildHandoffActivity leaves sequence unset, so
  // that column is NULL for every one of these rows and would degrade the
  // tiebreak to a random UUID) so the backfill agrees with
  // deriveHandoffThreadIdsFromActivities and deriveHandoffs on the read side.
  yield* sql`
    UPDATE projection_threads
    SET
      handoff_thread_id = (
        SELECT json_extract(activity.payload_json, '$.handoff.counterpartThreadId')
        FROM projection_thread_activities AS activity
        WHERE activity.thread_id = projection_threads.thread_id
          AND activity.kind = 'thread.handoff'
          AND json_extract(activity.payload_json, '$.handoff.direction') = 'continuedIn'
        ORDER BY activity.created_at DESC, activity.activity_id DESC
        LIMIT 1
      ),
      source_thread_id = (
        SELECT json_extract(activity.payload_json, '$.handoff.counterpartThreadId')
        FROM projection_thread_activities AS activity
        WHERE activity.thread_id = projection_threads.thread_id
          AND activity.kind = 'thread.handoff'
          AND json_extract(activity.payload_json, '$.handoff.direction') = 'spunOffFrom'
        ORDER BY activity.created_at DESC, activity.activity_id DESC
        LIMIT 1
      )
  `;
});
