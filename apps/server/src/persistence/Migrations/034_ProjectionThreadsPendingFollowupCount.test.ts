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

const insertFollowupActivity = (input: {
  readonly activityId: string;
  readonly threadId: string;
  readonly followupId: string;
  readonly status: string;
  readonly sequence: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
      )
      VALUES (
        ${input.activityId}, ${input.threadId}, NULL, 'info', 'turn.followup.suggested', 'A follow-up',
        ${`{"followup":{"id":"${input.followupId}","title":"A follow-up","status":"${input.status}"}}`},
        '2026-08-01T00:00:00.000Z', ${input.sequence}
      )
    `;
  });

layer("034_ProjectionThreadsPendingFollowupCount", (it) => {
  it.effect("backfills the pending count using the latest activity per follow-up id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });

      yield* insertThread("thread-1");
      yield* insertThread("thread-2");
      yield* insertThread("thread-3");

      // thread-1: one follow-up later dismissed, one still pending.
      yield* insertFollowupActivity({
        activityId: "activity-1",
        threadId: "thread-1",
        followupId: "followup-a",
        status: "pending",
        sequence: 1,
      });
      yield* insertFollowupActivity({
        activityId: "activity-2",
        threadId: "thread-1",
        followupId: "followup-b",
        status: "pending",
        sequence: 2,
      });
      yield* insertFollowupActivity({
        activityId: "activity-3",
        threadId: "thread-1",
        followupId: "followup-a",
        status: "dismissed",
        sequence: 3,
      });

      // thread-2: its only follow-up was spun off into its own thread.
      yield* insertFollowupActivity({
        activityId: "activity-4",
        threadId: "thread-2",
        followupId: "followup-c",
        status: "spunOff",
        sequence: 4,
      });

      // thread-3 has no follow-up activity at all.

      yield* runMigrations({ toMigrationInclusive: 34 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly pendingFollowupCount: number;
      }>`
        SELECT thread_id AS "threadId", pending_followup_count AS "pendingFollowupCount"
        FROM projection_threads
        ORDER BY thread_id ASC
      `;

      assert.deepStrictEqual(
        rows.map((row) => [row.threadId, row.pendingFollowupCount]),
        [
          ["thread-1", 1],
          ["thread-2", 0],
          ["thread-3", 0],
        ],
      );
    }),
  );

  it.effect("is safe to run when the column already exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 34 });
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;

      assert.isTrue(columns.some((column) => column.name === "pending_followup_count"));
    }),
  );
});
