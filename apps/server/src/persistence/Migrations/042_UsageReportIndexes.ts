import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Two indexes the usage report needs, and nothing else needed before.
 *
 * The report reads token counts by kind over a date range, and resolves which
 * model and account a turn ran on by reaching back to the turn's start event.
 * Without these it scans the whole activity table and the whole event log —
 * the event log being by far the largest table in the store — on every read.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_kind_created
    ON projection_thread_activities(kind, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_type_stream
    ON orchestration_events(event_type, stream_id)
  `;
});
