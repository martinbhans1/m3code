import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds the agent's end-of-turn verdict: whether the conversation is blocked on
 * the user ("needs_you") or finished ("done"), with a one-line reason. Stored
 * as JSON because the three fields only ever travel together.
 *
 * Nothing to backfill — no agent has given a verdict on an existing thread,
 * and "no verdict" is exactly what a null column says.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (columns.some((column) => column.name === "attention_json")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN attention_json TEXT
  `;
});
