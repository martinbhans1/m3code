import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import * as SqliteReadWorker from "./SqliteReadWorker.ts";

it.layer(NodeServices.layer)("SqliteReadWorker", (it) => {
  it.effect("reads what the main connection committed, and cannot write", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "sqlite-read-worker-" });
      const filename = path.join(dir, "state.sqlite");

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const reader = yield* SqliteReadWorker.SqliteReader;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL, data BLOB)`;
        yield* sql`INSERT INTO entries(name, data) VALUES (${"alpha"}, ${new Uint8Array([1, 2, 3])})`;

        const rows = yield* reader<{ readonly name: string; readonly data: Uint8Array }>`
          SELECT name, data FROM entries WHERE name IN ${reader.in(["alpha", "beta"])}
        `;
        assert.deepStrictEqual(
          rows.map((row) => [row.name, Array.from(row.data)]),
          [["alpha", [1, 2, 3]]],
        );

        // A later commit on the main connection is visible to the next read.
        yield* sql`INSERT INTO entries(name) VALUES (${"beta"})`;
        const count = yield* reader<{ readonly n: number }>`SELECT count(*) AS n FROM entries`;
        assert.equal(count[0]?.n, 2);

        // Read-only connection: a write fails rather than landing.
        const write = yield* Effect.exit(reader`INSERT INTO entries(name) VALUES (${"gamma"})`);
        assert.isTrue(Exit.isFailure(write));
        const after = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM entries`;
        assert.equal(after[0]?.n, 2);

        // A bad statement fails that query only; the worker keeps serving.
        const broken = yield* Effect.exit(reader`SELECT * FROM missing_table`);
        assert.isTrue(Exit.isFailure(broken));
        const again = yield* reader<{ readonly n: number }>`SELECT count(*) AS n FROM entries`;
        assert.equal(again[0]?.n, 2);
      }).pipe(
        Effect.provide(
          Layer.merge(NodeSqliteClient.layer({ filename }), SqliteReadWorker.layer({ filename })),
        ),
      );
    }),
  );

  it.effect("falls back to the main client when no reader is configured", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const chosen = yield* SqliteReadWorker.readerOr(sql);
      assert.strictEqual(chosen, sql);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
