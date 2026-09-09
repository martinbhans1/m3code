import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_usage_readings (
      reading_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      window_id TEXT NOT NULL,
      plan_label TEXT,
      percent REAL,
      window_minutes INTEGER,
      resets_at TEXT,
      captured_at TEXT NOT NULL,
      source TEXT NOT NULL,
      thread_id TEXT,
      turn_id TEXT
    )
  `;

  // The attribution query walks one window's readings in time order, pairing
  // each with its predecessor, so (instance, window, time) is the only access
  // path that matters.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_usage_readings_window_captured
    ON provider_usage_readings(instance_id, window_id, captured_at)
  `;
});
