import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_ConversationMessageSearch", (it) => {
  it.effect("indexes completed content and queues only changed threads for embeddings", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 34 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-1', 'Deal Journey', '/tmp/deal-journey', NULL,
          '[]', '2026-08-05T00:00:00.000Z', '2026-08-05T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id, created_at,
          updated_at, archived_at, latest_user_message_at, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan,
          pending_followup_count, deleted_at
        ) VALUES (
          'thread-1', 'project-1', 'Unexpected title',
          '{"provider":"codex","model":"gpt-5.4"}', 'full-access', 'default',
          NULL, NULL, NULL, '2026-08-05T00:00:00.000Z',
          '2026-08-05T00:00:00.000Z', NULL, NULL, 0, 0, 0, 0, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES
          (
            'message-1', 'thread-1', NULL, 'user', 'Fix the Visma NXT sprint tasks',
            NULL, 0, '2026-08-05T00:01:00.000Z', '2026-08-05T00:01:00.000Z'
          ),
          (
            'message-2', 'thread-1', NULL, 'assistant', 'Streaming placeholder',
            NULL, 1, '2026-08-05T00:02:00.000Z', '2026-08-05T00:02:00.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 35 });

      const initialMatches = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages_fts
        WHERE projection_thread_messages_fts MATCH '"visma"* AND "nxt"*'
      `;
      assert.deepStrictEqual(
        initialMatches.map((row) => row.text),
        ["Fix the Visma NXT sprint tasks"],
      );

      yield* sql`DELETE FROM conversation_search_semantic_dirty_threads`;
      yield* sql`
        UPDATE projection_thread_messages
        SET text = 'Completed response about sprint planning', is_streaming = 0
        WHERE message_id = 'message-2'
      `;

      const completedMatches = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages_fts
        WHERE projection_thread_messages_fts MATCH '"completed"*'
      `;
      assert.deepStrictEqual(
        completedMatches.map((row) => row.text),
        ["Completed response about sprint planning"],
      );

      const dirtyThreads = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId" FROM conversation_search_semantic_dirty_threads
      `;
      assert.deepStrictEqual(
        dirtyThreads.map((row) => row.threadId),
        ["thread-1"],
      );

      yield* sql`
        UPDATE projection_thread_messages
        SET text = 'Completed response about task projections'
        WHERE message_id = 'message-2'
      `;
      const removedMatches = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_messages_fts
        WHERE projection_thread_messages_fts MATCH '"planning"*'
      `;
      assert.strictEqual(removedMatches[0]?.count, 0);
    }),
  );
});
