import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_FixConversationSearchDirtyTriggers", (it) => {
  it.effect("keeps projection upserts working when a semantic dirty row already exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-1', 'Project', '/tmp/project', NULL,
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
          'thread-1', 'project-1', 'Thread', NULL, 'full-access', 'default',
          NULL, NULL, NULL, '2026-08-05T00:00:00.000Z',
          '2026-08-05T00:00:00.000Z', NULL, NULL, 0, 0, 0, 0, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (
          'message-1', 'thread-1', 'turn-1', 'assistant', 'First chunk', NULL,
          1, '2026-08-05T00:01:00.000Z', '2026-08-05T00:01:00.000Z'
        )
      `;

      // Migration 035 queues the thread. Keeping that row present exercises
      // both failure modes: the trigger sees an existing dirty row, and an
      // assistant delta arrives through the production-style outer upsert.
      yield* runMigrations({ toMigrationInclusive: 36 });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (
          'message-1', 'thread-1', 'turn-1', 'assistant',
          'First chunk and the rest', NULL, 1,
          '2026-08-05T00:01:00.000Z', '2026-08-05T00:02:00.000Z'
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          role = excluded.role,
          text = excluded.text,
          attachments_json = excluded.attachments_json,
          is_streaming = excluded.is_streaming,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `;

      const messages = yield* sql<{
        readonly text: string;
        readonly isStreaming: number;
      }>`
        SELECT text, is_streaming AS "isStreaming"
        FROM projection_thread_messages
        WHERE message_id = 'message-1'
      `;
      assert.deepStrictEqual(messages, [{ text: "First chunk and the rest", isStreaming: 1 }]);

      const dirtyThreads = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM conversation_search_semantic_dirty_threads
        ORDER BY thread_id ASC
      `;
      assert.deepStrictEqual(dirtyThreads, [{ threadId: "thread-1" }]);
    }),
  );
});
