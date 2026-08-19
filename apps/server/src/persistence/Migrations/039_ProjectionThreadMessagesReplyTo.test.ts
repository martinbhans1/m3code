import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("039_ProjectionThreadMessagesReplyTo", (it) => {
  it.effect("adds the anchor column, leaving existing messages in the main conversation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 38 });

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        VALUES (
          'message-1', 'thread-1', NULL, 'user', 'Hello', 0,
          '2026-08-19T09:00:00.000Z', '2026-08-19T09:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 39 });

      const rows = yield* sql<{
        readonly reply_to_message_id: string | null;
      }>`SELECT reply_to_message_id FROM projection_thread_messages WHERE message_id = 'message-1'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.reply_to_message_id, null);
    }),
  );

  it.effect("is safe to run twice", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 39 });
      yield* runMigrations({ toMigrationInclusive: 39 });
    }),
  );
});
