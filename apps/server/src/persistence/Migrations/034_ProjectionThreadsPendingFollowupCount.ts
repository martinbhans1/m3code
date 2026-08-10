import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Materializes the count of still-pending agent-suggested follow-ups per
 * thread, so the sidebar can flag threads holding a suggested task without
 * loading each thread's activities.
 *
 * The column is kept fresh by refreshThreadShellSummary (which already runs on
 * thread.activity-appended); this migration only has to create it and backfill
 * the threads that already carry follow-ups.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (columns.some((column) => column.name === "pending_followup_count")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN pending_followup_count INTEGER NOT NULL DEFAULT 0
  `;

  // Follow-ups are event-sourced: every create/update appends another
  // turn.followup.suggested activity carrying the whole record, and the latest
  // one per follow-up id wins. Rank by sequence so the backfill agrees with
  // deriveFollowups on the read side.
  yield* sql`
    UPDATE projection_threads
    SET pending_followup_count = COALESCE((
      SELECT COUNT(*)
      FROM (
        SELECT
          json_extract(activity.payload_json, '$.followup.status') AS status,
          ROW_NUMBER() OVER (
            PARTITION BY json_extract(activity.payload_json, '$.followup.id')
            ORDER BY activity.sequence DESC, activity.activity_id DESC
          ) AS rank
        FROM projection_thread_activities AS activity
        WHERE activity.thread_id = projection_threads.thread_id
          AND activity.kind = 'turn.followup.suggested'
          AND json_extract(activity.payload_json, '$.followup.id') IS NOT NULL
      )
      WHERE rank = 1 AND (status IS NULL OR status = 'pending')
    ), 0)
  `;
});
