import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE auth_devices (
    session_id TEXT PRIMARY KEY REFERENCES auth_sessions(session_id),
    proof_key_thumbprint TEXT NOT NULL,
    refresh_hash TEXT NOT NULL UNIQUE
  )`;
  yield* sql`CREATE TABLE auth_device_refresh_history (
    refresh_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES auth_devices(session_id),
    request_id TEXT NOT NULL,
    next_hash TEXT NOT NULL
  )`;
});
