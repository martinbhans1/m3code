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

// Deliberately inserts `sequence` as NULL and lets created_at do the ordering:
// buildHandoffActivity never sets a sequence, so that is what production rows
// actually look like. A fixture that supplies one would hide an ORDER BY that
// silently falls through to the random activity UUID.
const insertHandoffActivity = (input: {
  readonly activityId: string;
  readonly threadId: string;
  readonly direction: string;
  readonly counterpartThreadId: string;
  readonly createdAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
      )
      VALUES (
        ${input.activityId}, ${input.threadId}, NULL, 'info', 'thread.handoff', 'Handoff',
        ${`{"handoff":{"direction":"${input.direction}","counterpartThreadId":"${input.counterpartThreadId}","counterpartTitle":"Other","followupId":null,"createdAt":"${input.createdAt}"}}`},
        ${input.createdAt}, NULL
      )
    `;
  });

layer("038_ProjectionThreadsHandoff", (it) => {
  it.effect("backfills both directions using the latest activity per direction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 37 });

      yield* insertThread("thread-1");
      yield* insertThread("thread-2");
      yield* insertThread("thread-3");

      // thread-1 was handed off twice; only the most recent target counts. The
      // ids are chosen so the stale row sorts LAST alphabetically — if the
      // ORDER BY ever falls through to activity_id, this picks "thread-old".
      yield* insertHandoffActivity({
        activityId: "zz-stale",
        threadId: "thread-1",
        direction: "continuedIn",
        counterpartThreadId: "thread-old",
        createdAt: "2026-08-01T00:00:01.000Z",
      });
      yield* insertHandoffActivity({
        activityId: "aa-current",
        threadId: "thread-1",
        direction: "continuedIn",
        counterpartThreadId: "thread-2",
        createdAt: "2026-08-01T00:00:02.000Z",
      });

      // thread-2 is the other end of that handoff, and was itself handed off on.
      yield* insertHandoffActivity({
        activityId: "activity-3",
        threadId: "thread-2",
        direction: "spunOffFrom",
        counterpartThreadId: "thread-1",
        createdAt: "2026-08-01T00:00:03.000Z",
      });

      // thread-3 has no handoff activity at all.

      yield* runMigrations({ toMigrationInclusive: 38 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly handoffThreadId: string | null;
        readonly sourceThreadId: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          handoff_thread_id AS "handoffThreadId",
          source_thread_id AS "sourceThreadId"
        FROM projection_threads
        ORDER BY thread_id ASC
      `;

      assert.deepStrictEqual(
        rows.map((row) => [row.threadId, row.handoffThreadId, row.sourceThreadId]),
        [
          ["thread-1", "thread-2", null],
          ["thread-2", null, "thread-1"],
          ["thread-3", null, null],
        ],
      );
    }),
  );

  it.effect("is safe to run when the columns already exist", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 38 });
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;

      assert.isTrue(columns.some((column) => column.name === "handoff_thread_id"));
      assert.isTrue(columns.some((column) => column.name === "source_thread_id"));
    }),
  );
});
