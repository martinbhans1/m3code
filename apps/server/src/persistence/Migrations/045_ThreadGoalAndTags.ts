import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds a per-thread goal and tags, and a per-project tag vocabulary.
 *
 * - `projection_threads.goal`: what "finished" means for the conversation.
 * - `projection_threads.tags_json`: names drawn from the project's vocabulary.
 * - `projection_projects.thread_tags_json`: that vocabulary, name + description.
 *
 * Nothing to backfill: no thread has a goal or tags yet, and an empty
 * vocabulary is exactly what a project that has never been tagged has.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "goal")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN goal TEXT`;
  }
  if (!threadColumns.some((column) => column.name === "tags_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'`;
  }

  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!projectColumns.some((column) => column.name === "thread_tags_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN thread_tags_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
