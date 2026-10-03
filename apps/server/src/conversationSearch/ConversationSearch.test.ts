import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { ConversationSearch, ConversationSearchLive } from "./ConversationSearch.ts";

const layer = it.layer(
  Layer.mergeAll(
    NodeSqliteClient.layerMemory(),
    ServerConfig.layerTest(process.cwd(), { prefix: "conversation-search-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
);
layer("conversation date filtering", (it) => {
  it.effect(
    "filters metadata, keyword, relaxed and exact matches before applying the limit, including the cutoff",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
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

        yield* sql`UPDATE projection_threads SET title = 'Visma sprint tasks'`;
        yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at
      ) VALUES (
        'recent', 'project-1', 'Visma sprint tasks',
        '{"provider":"codex","model":"gpt-5.4"}', 'full-access', 'default',
        '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z'
      )
    `;
        yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES ('recent-message', 'recent', 'user', 'Fix the Visma NXT sprint tasks', 0,
        '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z')
    `;
        yield* Effect.gen(function* () {
          const search = yield* ConversationSearch;
          for (const input of [
            { query: "Visma" },
            { query: "NXT" },
            { query: "NXT absentword" },
            { query: "Visma NXT", exact: true },
          ]) {
            const all = yield* search.search({ ...input, includeSemantic: false });
            assert.deepStrictEqual(
              new Set(all.results.map((row) => row.threadId)),
              new Set(["recent", "thread-1"]),
            );
            const recent = yield* search.search({
              ...input,
              includeSemantic: false,
              updatedSince: "2026-09-08T00:00:00.000Z",
              limit: 1,
            });
            assert.deepStrictEqual(
              recent.results.map((row) => row.threadId),
              ["recent"],
            );
            const none = yield* search.search({
              ...input,
              includeSemantic: false,
              updatedSince: "2026-09-08T00:00:00.001Z",
            });
            assert.deepStrictEqual(none.results, []);
          }
        }).pipe(Effect.provide(ConversationSearchLive));
      }),
  );
});
