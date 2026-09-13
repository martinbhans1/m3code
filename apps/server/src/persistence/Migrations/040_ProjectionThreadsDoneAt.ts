import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds the "settled" stamp: a conversation the user has finished with, which
 * stays in the list and stays searchable rather than disappearing the way an
 * archived one does.
 *
 * Nothing to backfill — every existing thread starts un-stamped, which is the
 * truthful answer for work nobody has ruled on yet.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (columns.some((column) => column.name === "done_at")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN done_at TEXT
  `;
});
