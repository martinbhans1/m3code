import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

// Both tests share one in-memory database, so seeding tolerates a table the
// previous test already populated.
const seedProjectAndThread = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT OR IGNORE INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      'project-1', 'Deal Journey', '/tmp/deal-journey', NULL,
      '[]', '2026-08-05T00:00:00.000Z', '2026-08-05T00:00:00.000Z', NULL
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, branch, worktree_path, latest_turn_id, created_at,
      updated_at, archived_at, latest_user_message_at, pending_approval_count,
      pending_user_input_count, has_actionable_proposed_plan,
      pending_followup_count, deleted_at
    ) VALUES (
      'thread-1', 'project-1', 'Trigram fixture',
      '{"provider":"codex","model":"gpt-5.4"}', 'full-access', 'default',
      NULL, NULL, NULL, '2026-08-05T00:00:00.000Z',
      '2026-08-05T00:00:00.000Z', NULL, NULL, 0, 0, 0, 0, NULL
    )
  `;
});

const insertMessage = (id: string, text: string, isStreaming: 0 | 1) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, attachments_json,
        is_streaming, created_at, updated_at
      ) VALUES (
        ${id}, 'thread-1', NULL, 'assistant', ${text}, NULL, ${isStreaming},
        '2026-08-05T00:01:00.000Z', '2026-08-05T00:01:00.000Z'
      )
    `;
  });

const matchCount = (query: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM projection_thread_messages_trigram
      WHERE projection_thread_messages_trigram MATCH ${`"${query.replaceAll('"', '""')}"`}
    `;
    return rows[0]?.n ?? 0;
  });

layer("037_ConversationMessageTrigramIndex", (it) => {
  it.effect("backfills existing messages and finds substrings the word index cannot", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 36 });
      yield* seedProjectAndThread;
      // Punctuation and mid-identifier text: exactly what a tokenizing index
      // cannot represent, and the reason this one exists.
      yield* insertMessage("message-1", "the html had a stray --> in it", 0);
      yield* insertMessage("message-2", "reads pending_followup_count per thread", 0);
      yield* insertMessage("message-3", "half-written response", 1);

      yield* runMigrations({ toMigrationInclusive: 37 });

      assert.strictEqual(yield* matchCount("-->"), 1);
      assert.strictEqual(yield* matchCount("ollowup_cou"), 1, "matches inside a word");
      assert.strictEqual(yield* matchCount("PENDING_FOLLOWUP"), 1, "trigram ignores case");
      assert.strictEqual(yield* matchCount("nothing here"), 0);
      // Streaming rows stay out, so a long response does not rewrite the index
      // on every token.
      assert.strictEqual(yield* matchCount("half-written"), 0);
    }),
  );

  it.effect("keeps the index in step as messages are written, finished and removed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* seedProjectAndThread;

      yield* insertMessage("live-1", "first draft mentions widgets", 0);
      assert.strictEqual(yield* matchCount("widgets"), 1);

      // A streaming message lands in the index only once it settles.
      yield* insertMessage("live-2", "partial", 1);
      assert.strictEqual(yield* matchCount("partial"), 0);
      yield* sql`
        UPDATE projection_thread_messages
        SET text = 'finished answer about gadgets', is_streaming = 0
        WHERE message_id = 'live-2'
      `;
      assert.strictEqual(yield* matchCount("gadgets"), 1);
      assert.strictEqual(yield* matchCount("partial"), 0);

      // An edit must not leave the old text findable.
      yield* sql`
        UPDATE projection_thread_messages
        SET text = 'first draft mentions sprockets'
        WHERE message_id = 'live-1'
      `;
      assert.strictEqual(yield* matchCount("widgets"), 0, "stale text must not linger");
      assert.strictEqual(yield* matchCount("sprockets"), 1);

      yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'live-1'`;
      assert.strictEqual(yield* matchCount("sprockets"), 0);
      assert.strictEqual(yield* matchCount("gadgets"), 1, "unrelated rows survive");
    }),
  );
});
