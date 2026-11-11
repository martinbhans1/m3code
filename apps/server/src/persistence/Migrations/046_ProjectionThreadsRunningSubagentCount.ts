import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Materializes how many subagents a thread has started and not yet heard back
 * from, so the sidebar can tell "the agent finished" apart from "the agent's
 * turn ended but its subagents are still working".
 *
 * Kept fresh by refreshThreadShellSummary on task.started / task.completed
 * activities. The backfill only matters for threads with a subagent still in
 * flight at upgrade time; anything older is long finished or dead, and the
 * client ignores counts on a session that is no longer alive anyway.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (columns.some((column) => column.name === "running_subagent_count")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN running_subagent_count INTEGER NOT NULL DEFAULT 0
  `;

  yield* sql`
    UPDATE projection_threads
    SET running_subagent_count = COALESCE((
      SELECT COUNT(DISTINCT json_extract(started.payload_json, '$.taskId'))
      FROM projection_thread_activities AS started
      WHERE started.thread_id = projection_threads.thread_id
        AND started.kind = 'task.started'
        AND json_extract(started.payload_json, '$.taskType') IN ('local_agent', 'local_workflow')
        AND NOT EXISTS (
          SELECT 1
          FROM projection_thread_activities AS completed
          WHERE completed.thread_id = started.thread_id
            AND completed.kind = 'task.completed'
            AND json_extract(completed.payload_json, '$.taskId')
              = json_extract(started.payload_json, '$.taskId')
        )
    ), 0)
  `;
});
