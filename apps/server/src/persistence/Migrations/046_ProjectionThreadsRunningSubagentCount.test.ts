import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const insertThread = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, branch, worktree_path, latest_turn_id, created_at,
      updated_at, archived_at, latest_user_message_at, pending_approval_count,
      pending_user_input_count, has_actionable_proposed_plan, deleted_at
    )
    VALUES (
      ${threadId}, 'project-1', 'Thread', '{"provider":"codex","model":"gpt-5-codex"}',
      'full-access', 'default', NULL, NULL, NULL, '2026-08-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z', NULL, NULL, 0, 0, 0, NULL
    )
  `;
  });

let sequence = 0;
const insertTask = (input: {
  readonly threadId: string;
  readonly kind: "task.started" | "task.completed";
  readonly taskId: string;
  readonly taskType?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    sequence += 1;
    const payload = JSON.stringify({
      taskId: input.taskId,
      ...(input.taskType ? { taskType: input.taskType } : { status: "completed" }),
    });
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
      )
      VALUES (
        ${`activity-${sequence}`}, ${input.threadId}, NULL, 'info', ${input.kind}, 'Task',
        ${payload}, '2026-08-01T00:00:00.000Z', ${sequence}
      )
    `;
  });

layer("046_ProjectionThreadsRunningSubagentCount", (it) => {
  it.effect("backfills subagents still in flight, ignoring finished ones and shell tasks", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 45 });

      yield* insertThread("thread-1");
      yield* insertThread("thread-2");

      yield* insertTask({
        threadId: "thread-1",
        kind: "task.started",
        taskId: "a",
        taskType: "local_agent",
      });
      yield* insertTask({
        threadId: "thread-1",
        kind: "task.started",
        taskId: "b",
        taskType: "local_agent",
      });
      yield* insertTask({ threadId: "thread-1", kind: "task.completed", taskId: "a" });
      yield* insertTask({
        threadId: "thread-1",
        kind: "task.started",
        taskId: "sh",
        taskType: "local_bash",
      });
      yield* insertTask({
        threadId: "thread-2",
        kind: "task.started",
        taskId: "c",
        taskType: "local_agent",
      });
      yield* insertTask({ threadId: "thread-2", kind: "task.completed", taskId: "c" });

      yield* runMigrations({ toMigrationInclusive: 46 });

      const rows = yield* sql<{ readonly threadId: string; readonly count: number }>`
        SELECT thread_id AS "threadId", running_subagent_count AS "count"
        FROM projection_threads
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(rows, [
        { threadId: "thread-1", count: 1 },
        { threadId: "thread-2", count: 0 },
      ]);
    }),
  );
});
