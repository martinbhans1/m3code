import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Side threads: a user message can hang off an earlier message in the same
 * conversation. Only the user message carries the anchor — everything its turn
 * produces is attributed through the turn id.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;

  if (columns.some((column) => column.name === "reply_to_message_id")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN reply_to_message_id TEXT
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_reply_to
    ON projection_thread_messages(reply_to_message_id)
    WHERE reply_to_message_id IS NOT NULL
  `;
});
