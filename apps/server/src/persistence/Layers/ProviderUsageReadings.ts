import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProviderUsageReadingsBeforeInput,
  ProviderUsageReading,
  ProviderUsageReadingRepository,
  type ProviderUsageReadingRepositoryShape,
} from "../Services/ProviderUsageReadings.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

/**
 * Every filter is bound as a nullable parameter and tested with
 * `(? IS NULL OR column …)` rather than assembled into different statements.
 * SQLite still uses the covering index for the bounds it is given, and one
 * prepared statement stays one prepared statement.
 */
const ListReadingsRequest = Schema.Struct({
  instanceId: Schema.NullOr(ProviderInstanceId),
  windowId: Schema.NullOr(Schema.String),
  since: Schema.NullOr(Schema.String),
  until: Schema.NullOr(Schema.String),
});

const InstanceIdRow = Schema.Struct({ instanceId: ProviderInstanceId });

const makeProviderUsageReadingRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertReadingRow = SqlSchema.void({
    Request: ProviderUsageReading,
    execute: (row) =>
      sql`
        INSERT INTO provider_usage_readings (
          reading_id,
          instance_id,
          window_id,
          plan_label,
          percent,
          window_minutes,
          resets_at,
          captured_at,
          source,
          thread_id,
          turn_id
        )
        VALUES (
          ${row.readingId},
          ${row.instanceId},
          ${row.windowId},
          ${row.planLabel},
          ${row.percent},
          ${row.windowMinutes},
          ${row.resetsAt},
          ${row.capturedAt},
          ${row.source},
          ${row.threadId},
          ${row.turnId}
        )
        ON CONFLICT (reading_id) DO NOTHING
      `,
  });

  const listReadingRows = SqlSchema.findAll({
    Request: ListReadingsRequest,
    Result: ProviderUsageReading,
    execute: ({ instanceId, windowId, since, until }) =>
      sql`
        SELECT
          reading_id AS "readingId",
          instance_id AS "instanceId",
          window_id AS "windowId",
          plan_label AS "planLabel",
          percent,
          window_minutes AS "windowMinutes",
          resets_at AS "resetsAt",
          captured_at AS "capturedAt",
          source,
          thread_id AS "threadId",
          turn_id AS "turnId"
        FROM provider_usage_readings
        WHERE (${instanceId} IS NULL OR instance_id = ${instanceId})
          AND (${windowId} IS NULL OR window_id = ${windowId})
          AND (${since} IS NULL OR captured_at >= ${since})
          AND (${until} IS NULL OR captured_at < ${until})
        ORDER BY captured_at ASC, reading_id ASC
      `,
  });

  const listInstanceIdRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: InstanceIdRow,
    execute: () =>
      sql`
        SELECT DISTINCT instance_id AS "instanceId"
        FROM provider_usage_readings
        ORDER BY instance_id ASC
      `,
  });

  const deleteReadingRowsBefore = SqlSchema.void({
    Request: DeleteProviderUsageReadingsBeforeInput,
    execute: ({ before }) =>
      sql`
        DELETE FROM provider_usage_readings
        WHERE captured_at < ${before}
      `,
  });

  const append: ProviderUsageReadingRepositoryShape["append"] = (rows) =>
    Effect.forEach(rows, (row) => insertReadingRow(row), { discard: true }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderUsageReadingRepository.append:query",
          "ProviderUsageReadingRepository.append:encodeRequest",
        ),
      ),
    );

  const list: ProviderUsageReadingRepositoryShape["list"] = (input) =>
    listReadingRows({
      instanceId: input.instanceId ?? null,
      windowId: input.windowId ?? null,
      since: input.since ?? null,
      until: input.until ?? null,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderUsageReadingRepository.list:query",
          "ProviderUsageReadingRepository.list:decodeRows",
        ),
      ),
    );

  const listInstanceIds: ProviderUsageReadingRepositoryShape["listInstanceIds"] = () =>
    listInstanceIdRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderUsageReadingRepository.listInstanceIds:query",
          "ProviderUsageReadingRepository.listInstanceIds:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.instanceId)),
    );

  const deleteBefore: ProviderUsageReadingRepositoryShape["deleteBefore"] = (input) =>
    deleteReadingRowsBefore(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderUsageReadingRepository.deleteBefore:query",
          "ProviderUsageReadingRepository.deleteBefore:encodeRequest",
        ),
      ),
    );

  return {
    append,
    list,
    listInstanceIds,
    deleteBefore,
  } satisfies ProviderUsageReadingRepositoryShape;
});

export const ProviderUsageReadingRepositoryLive = Layer.effect(
  ProviderUsageReadingRepository,
  makeProviderUsageReadingRepository,
);
