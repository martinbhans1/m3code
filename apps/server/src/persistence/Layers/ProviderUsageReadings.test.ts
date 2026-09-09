import { IsoDateTime, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderUsageReadingRepositoryLive } from "./ProviderUsageReadings.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import {
  ProviderUsageReadingRepository,
  type ProviderUsageReading,
} from "../Services/ProviderUsageReadings.ts";

const layer = it.layer(
  Layer.mergeAll(
    ProviderUsageReadingRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const reading = (overrides: Partial<ProviderUsageReading> = {}): ProviderUsageReading => ({
  readingId: "event-1:seven_day",
  instanceId: ProviderInstanceId.make("claude_dj2"),
  windowId: "seven_day",
  planLabel: "max",
  percent: 12.5,
  windowMinutes: 10_080,
  resetsAt: IsoDateTime.make("2026-09-14T00:00:00.000Z"),
  capturedAt: IsoDateTime.make("2026-09-09T10:00:00.000Z"),
  source: "probe",
  threadId: ThreadId.make("11111111-1111-4111-8111-111111111111"),
  turnId: TurnId.make("22222222-2222-4222-8222-222222222222"),
  ...overrides,
});

// One in-memory database is shared by the whole suite, so each test works
// against its own account rather than assuming an empty table.
layer("ProviderUsageReadingRepository", (it) => {
  it.effect("keeps a reading verbatim, including the work that was live", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderUsageReadingRepository;
      const instanceId = ProviderInstanceId.make("verbatim");
      const row = reading({ instanceId });
      yield* repository.append([row]);

      const rows = yield* repository.list({ instanceId });
      assert.deepEqual(rows, [row]);
    }),
  );

  it.effect("ignores a replayed reading rather than double-counting it", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderUsageReadingRepository;
      const instanceId = ProviderInstanceId.make("replayed");
      const readingId = "event-replayed:seven_day";
      yield* repository.append([reading({ readingId, instanceId })]);
      yield* repository.append([reading({ readingId, instanceId, percent: 99 })]);

      const rows = yield* repository.list({ instanceId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.percent, 12.5);
    }),
  );

  it.effect("keeps a window the provider declined to put a number on", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderUsageReadingRepository;
      const instanceId = ProviderInstanceId.make("unreported");
      yield* repository.append([
        reading({ readingId: "event-2:seven_day", instanceId, percent: null, resetsAt: null }),
      ]);

      const rows = yield* repository.list({ instanceId });
      assert.equal(rows[0]?.percent, null);
      assert.equal(rows[0]?.resetsAt, null);
    }),
  );

  it.effect("filters by account, window and time, and returns oldest first", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderUsageReadingRepository;
      const instanceId = ProviderInstanceId.make("filtered");
      const other = ProviderInstanceId.make("filtered-other");
      yield* repository.append([
        reading({
          readingId: "a",
          instanceId,
          capturedAt: IsoDateTime.make("2026-09-09T12:00:00.000Z"),
        }),
        reading({
          readingId: "b",
          instanceId,
          capturedAt: IsoDateTime.make("2026-09-09T09:00:00.000Z"),
        }),
        reading({ readingId: "c", instanceId, windowId: "five_hour" }),
        reading({ readingId: "d", instanceId: other }),
      ]);

      const weekly = yield* repository.list({ instanceId, windowId: "seven_day" });
      assert.deepEqual(
        weekly.map((row) => row.readingId),
        ["b", "a"],
      );

      const bounded = yield* repository.list({
        instanceId,
        windowId: "seven_day",
        since: IsoDateTime.make("2026-09-09T10:00:00.000Z"),
      });
      assert.deepEqual(
        bounded.map((row) => row.readingId),
        ["a"],
      );
    }),
  );

  it.effect("lists the accounts it holds readings for", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderUsageReadingRepository;
      const first = ProviderInstanceId.make("listed-a");
      const second = ProviderInstanceId.make("listed-b");
      yield* repository.append([
        reading({ readingId: "listed-a", instanceId: first }),
        reading({ readingId: "listed-b", instanceId: second }),
      ]);

      const instances = yield* repository.listInstanceIds();
      assert.isTrue(instances.includes(first));
      assert.isTrue(instances.includes(second));
    }),
  );

  it.effect("prunes readings older than a cutoff", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderUsageReadingRepository;
      const instanceId = ProviderInstanceId.make("pruned");
      yield* repository.append([
        reading({
          readingId: "old",
          instanceId,
          capturedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
        }),
        reading({ readingId: "new", instanceId }),
      ]);

      yield* repository.deleteBefore({ before: IsoDateTime.make("2026-06-01T00:00:00.000Z") });

      const rows = yield* repository.list({ instanceId });
      assert.deepEqual(
        rows.map((row) => row.readingId),
        ["new"],
      );
    }),
  );
});
