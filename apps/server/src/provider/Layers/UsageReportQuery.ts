import {
  IsoDateTime,
  ProjectId,
  ProviderInstanceId,
  type ThreadTokenUsageSnapshot,
  type ServerUsageReportAccount,
  type ServerUsageReportInput,
  type ServerUsageReportResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ProviderUsageReadingRepository,
  type ProviderUsageReading,
} from "../../persistence/Services/ProviderUsageReadings.ts";
import { claudeWindowLabel } from "../ClaudeUsage.ts";
import { codexWindowLabel } from "../CodexUsage.ts";
import { UsageReportQuery, type UsageReportQueryShape } from "../Services/UsageReportQuery.ts";
import {
  attributeUsage,
  estimateBillableTokens,
  type UsageWorkSample,
} from "../usageAttribution.ts";

/** How many reset periods to return when the caller does not say. */
const DEFAULT_PERIOD_LIMIT = 8;

/**
 * Windows an invoice is written against, longest first.
 *
 * An account's readings usually cover several windows at once (a session
 * window, a weekly one, a per-model weekly one). The weekly window is the one
 * a shared subscription is actually rationed by, so it is the default; the
 * caller can name any other, and the UI lists what else was recorded.
 */
const selectDefaultWindowId = (
  readings: ReadonlyArray<ProviderUsageReading>,
): string | undefined => {
  let best: { id: string; minutes: number } | undefined;
  for (const reading of readings) {
    const minutes = reading.windowMinutes ?? 0;
    if (best === undefined || minutes > best.minutes) {
      best = { id: reading.windowId, minutes };
    }
  }
  return best?.id;
};

/**
 * Label a window without having stored one.
 *
 * Claude's ids are names (`seven_day_opus`); Codex's are precedence slots
 * (`primary`) whose meaning is only in their duration. Both label functions
 * already exist for the composer meter, so neither vocabulary is restated here.
 */
const usageWindowLabel = (windowId: string, windowMinutes: number | null): string => {
  if (windowId === "primary" || windowId === "secondary") {
    return codexWindowLabel({ id: windowId, windowDurationMins: windowMinutes });
  }
  return claudeWindowLabel(windowId);
};

const TokenSampleRow = Schema.Struct({
  createdAt: Schema.String,
  threadId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  payloadJson: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  projectTitle: Schema.NullOr(Schema.String),
  threadModelSelectionJson: Schema.NullOr(Schema.String),
});

const TurnModelRow = Schema.Struct({
  turnId: Schema.String,
  model: Schema.NullOr(Schema.String),
  instanceId: Schema.NullOr(Schema.String),
});

const TimeRangeRequest = Schema.Struct({
  since: Schema.String,
  until: Schema.String,
});

interface ResolvedSelection {
  readonly model: string | null;
  readonly instanceId: string | null;
}

const readSelectionJson = (value: string | null): ResolvedSelection => {
  if (!value) return { model: null, instanceId: null };
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return { model: null, instanceId: null };
    const record = parsed as Record<string, unknown>;
    return {
      model: typeof record["model"] === "string" ? record["model"] : null,
      instanceId: typeof record["instanceId"] === "string" ? record["instanceId"] : null,
    };
  } catch {
    return { model: null, instanceId: null };
  }
};

/**
 * Read a stored token snapshot back into the shape the estimator expects.
 *
 * Activity payloads are persisted as opaque JSON, so this is the boundary
 * where they become typed again. A payload that has drifted contributes zero
 * rather than throwing: one unreadable sample must not fail a whole report.
 */
const readTokenSnapshot = (value: string): number => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return 0;
    return estimateBillableTokens(parsed as ThreadTokenUsageSnapshot);
  } catch {
    return 0;
  }
};

const makeUsageReportQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const readingRepository = yield* ProviderUsageReadingRepository;

  /**
   * Every recorded response in a time range, with the conversation and project
   * it belongs to and the thread's current model choice as a fallback.
   */
  const listTokenSampleRows = SqlSchema.findAll({
    Request: TimeRangeRequest,
    Result: TokenSampleRow,
    execute: ({ since, until }) =>
      sql`
        SELECT
          activities.created_at AS "createdAt",
          activities.thread_id AS "threadId",
          activities.turn_id AS "turnId",
          activities.payload_json AS "payloadJson",
          threads.project_id AS "projectId",
          projects.title AS "projectTitle",
          threads.model_selection_json AS "threadModelSelectionJson"
        FROM projection_thread_activities AS activities
        JOIN projection_threads AS threads
          ON threads.thread_id = activities.thread_id
        LEFT JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE activities.kind = 'context-window.updated'
          AND activities.created_at >= ${since}
          AND activities.created_at < ${until}
        ORDER BY activities.created_at ASC
      `,
  });

  /**
   * The account and model each turn ran on.
   *
   * Only the turn's own start request knows this: the choice stored on the
   * thread is whatever was picked most recently, which is wrong the moment the
   * model is switched mid-conversation. The request is matched by the message it
   * started, since that is the pairing the projection already keeps.
   */
  const listTurnModelRows = SqlSchema.findAll({
    Request: TimeRangeRequest,
    Result: TurnModelRow,
    execute: ({ since, until }) =>
      sql`
        SELECT
          turns.turn_id AS "turnId",
          json_extract(events.payload_json, '$.modelSelection.model') AS "model",
          json_extract(events.payload_json, '$.modelSelection.instanceId') AS "instanceId"
        FROM projection_turns AS turns
        JOIN orchestration_events AS events
          ON events.event_type = 'thread.turn-start-requested'
         AND events.stream_id = turns.thread_id
         AND json_extract(events.payload_json, '$.messageId') = turns.pending_message_id
        WHERE turns.requested_at >= ${since}
          AND turns.requested_at < ${until}
      `,
  });

  const getUsageReport: UsageReportQueryShape["getUsageReport"] = (input: ServerUsageReportInput) =>
    Effect.gen(function* () {
      const readAt = IsoDateTime.make(DateTime.formatIso(yield* DateTime.now));
      const allReadings = yield* readingRepository.list(
        input.instanceId === undefined ? {} : { instanceId: input.instanceId },
      );

      if (allReadings.length === 0) {
        return {
          readAt,
          recordingSince: null,
          accounts: [],
        } satisfies ServerUsageReportResult;
      }

      const recordingSince = allReadings[0]?.capturedAt ?? null;
      const periodLimit = input.periodLimit ?? DEFAULT_PERIOD_LIMIT;

      const readingsByInstance = new Map<string, Array<ProviderUsageReading>>();
      for (const reading of allReadings) {
        const bucket = readingsByInstance.get(reading.instanceId);
        if (bucket) bucket.push(reading);
        else readingsByInstance.set(reading.instanceId, [reading]);
      }

      // Trim to the requested number of reset periods *before* loading any
      // samples, so the sample scan is bounded by what will actually be
      // rendered rather than by how long recording has been running.
      const selected = new Map<
        string,
        {
          windowId: string;
          readings: ReadonlyArray<ProviderUsageReading>;
          windowIds: Array<string>;
        }
      >();
      let earliest: string | undefined;
      for (const [instanceId, readings] of readingsByInstance) {
        const windowIds = [...new Set(readings.map((reading) => reading.windowId))].sort();
        const windowId = input.windowId ?? selectDefaultWindowId(readings);
        if (windowId === undefined) continue;

        const windowReadings = readings.filter((reading) => reading.windowId === windowId);
        if (windowReadings.length === 0) continue;

        const periodKeys = [...new Set(windowReadings.map((reading) => reading.resetsAt ?? ""))];
        const keptKeys = new Set(periodKeys.slice(-periodLimit));
        const kept = windowReadings.filter((reading) => keptKeys.has(reading.resetsAt ?? ""));
        if (kept.length === 0) continue;

        selected.set(instanceId, { windowId, readings: kept, windowIds });
        const first = kept[0]?.capturedAt;
        if (first !== undefined && (earliest === undefined || first < earliest)) earliest = first;
      }

      if (selected.size === 0 || earliest === undefined) {
        return { readAt, recordingSince, accounts: [] } satisfies ServerUsageReportResult;
      }

      const range = { since: earliest, until: readAt };
      const sampleRows = yield* listTokenSampleRows(range).pipe(
        Effect.mapError(toQueryError("listTokenSamples")),
      );
      const turnRows = yield* listTurnModelRows(range).pipe(
        Effect.mapError(toQueryError("listTurnModels")),
      );

      const turnSelections = new Map<string, ResolvedSelection>();
      for (const row of turnRows) {
        turnSelections.set(row.turnId, { model: row.model, instanceId: row.instanceId });
      }

      const samplesByInstance = new Map<string, Array<UsageWorkSample>>();
      for (const row of sampleRows) {
        const tokens = readTokenSnapshot(row.payloadJson);
        if (tokens <= 0) continue;

        // The turn's own choice is authoritative; the thread's latest choice
        // only stands in for turns whose start request is no longer around —
        // resumed turns, and anything recorded before this join existed.
        const fromTurn = row.turnId === null ? undefined : turnSelections.get(row.turnId);
        const fallback = readSelectionJson(row.threadModelSelectionJson);
        const instanceId = fromTurn?.instanceId ?? fallback.instanceId;
        if (instanceId === null || instanceId === undefined) continue;

        const sample: UsageWorkSample = {
          at: row.createdAt,
          threadId: row.threadId,
          projectId: row.projectId,
          projectTitle: row.projectTitle,
          model: fromTurn?.model ?? fallback.model,
          tokens,
        };
        const bucket = samplesByInstance.get(instanceId);
        if (bucket) bucket.push(sample);
        else samplesByInstance.set(instanceId, [sample]);
      }

      const accounts: Array<ServerUsageReportAccount> = [];
      for (const [instanceId, entry] of selected) {
        const windowMinutes =
          entry.readings.find((reading) => reading.windowMinutes !== null)?.windowMinutes ?? null;
        const planLabel =
          entry.readings.toReversed().find((reading) => reading.planLabel !== null)?.planLabel ??
          null;

        const periods = attributeUsage({
          windowId: entry.windowId,
          readings: entry.readings.map((reading) => ({
            percent: reading.percent,
            resetsAt: reading.resetsAt,
            capturedAt: reading.capturedAt,
          })),
          samples: samplesByInstance.get(instanceId) ?? [],
        });

        accounts.push({
          instanceId: ProviderInstanceId.make(instanceId),
          planLabel,
          windowId: entry.windowId,
          windowLabel: usageWindowLabel(entry.windowId, windowMinutes),
          windowMinutes,
          availableWindowIds: entry.windowIds,
          periods: periods.map((period) => ({
            resetsAt: period.resetsAt === null ? null : IsoDateTime.make(period.resetsAt),
            firstReadingAt: IsoDateTime.make(period.firstReadingAt),
            lastReadingAt: IsoDateTime.make(period.lastReadingAt),
            openingPercent: period.openingPercent,
            closingPercent: period.closingPercent,
            observedPercent: period.observedPercent,
            attributedPercent: period.attributedPercent,
            elsewherePercent: period.elsewherePercent,
            allocations: period.allocations.map((allocation) => ({
              projectId:
                allocation.projectId === null ? null : ProjectId.make(allocation.projectId),
              projectTitle: allocation.projectTitle,
              model: allocation.model,
              percent: allocation.percent,
              tokens: allocation.tokens,
            })),
          })),
        });
      }

      accounts.sort((left, right) => left.instanceId.localeCompare(right.instanceId));

      return { readAt, recordingSince, accounts } satisfies ServerUsageReportResult;
    });

  return { getUsageReport } satisfies UsageReportQueryShape;
});

function toQueryError(operation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`UsageReportQuery.${operation}:decodeRows`)(cause)
      : toPersistenceSqlError(`UsageReportQuery.${operation}:query`)(cause);
}

export const UsageReportQueryLive = Layer.effect(UsageReportQuery, makeUsageReportQuery);
