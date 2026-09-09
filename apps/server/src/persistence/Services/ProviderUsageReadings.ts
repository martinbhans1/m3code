/**
 * ProviderUsageReadingRepository — durable history of plan rate-limit readings.
 *
 * `ServerProviderUsage` is a *live* value: `ProviderUsageRegistry` holds the
 * latest merged snapshot in memory so the composer meter can render it, and
 * that snapshot dies with the process. Nothing else keeps it, which makes the
 * one question an account holder actually needs answered — "how much of this
 * week's allowance did this machine burn, and on what?" — unanswerable after
 * a restart, and unanswerable retroactively at any time.
 *
 * This repository is the missing tape. Every observation of a window (probe or
 * push) is appended verbatim, with the thread and turn that were live when the
 * provider reported it. Nothing is interpreted on the way in: attribution is a
 * pure function of the tape plus turn history (`usageAttribution.ts`), so the
 * accounting rules can be corrected later without having lost the evidence.
 *
 * Rows are per *window*, not per observation: one probe carries five Claude
 * windows, and the weekly window is the only one an invoice cares about, so
 * splitting them here keeps the read path a single indexed scan.
 *
 * @module ProviderUsageReadingRepository
 */
import { IsoDateTime, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

/**
 * One window's utilization as the provider reported it at a moment in time.
 *
 * `percent` and `resetsAt` are nullable for the same reason they are nullable
 * in the contract: a window can exist while the provider declines to say how
 * full it is. Such rows are kept rather than dropped — they still prove the
 * window was observed, which is what distinguishes "nothing happened" from
 * "the app was not running".
 */
export const ProviderUsageReading = Schema.Struct({
  readingId: Schema.String,
  instanceId: ProviderInstanceId,
  windowId: Schema.String,
  planLabel: Schema.NullOr(Schema.String),
  percent: Schema.NullOr(Schema.Number),
  windowMinutes: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(IsoDateTime),
  capturedAt: IsoDateTime,
  source: Schema.Literals(["event", "probe"]),
  // The thread and turn that were live when the provider volunteered this
  // reading. Recorded as a hint, never as the attribution itself: with a dozen
  // conversations running at once the turn that happened to trigger the probe
  // is rarely the only one that moved the number.
  threadId: Schema.NullOr(ThreadId),
  turnId: Schema.NullOr(TurnId),
});
export type ProviderUsageReading = typeof ProviderUsageReading.Type;

export const ListProviderUsageReadingsInput = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
  windowId: Schema.optional(Schema.String),
  /** Inclusive lower bound on `capturedAt`. */
  since: Schema.optional(IsoDateTime),
  /** Exclusive upper bound on `capturedAt`. */
  until: Schema.optional(IsoDateTime),
});
export type ListProviderUsageReadingsInput = typeof ListProviderUsageReadingsInput.Type;

export const DeleteProviderUsageReadingsBeforeInput = Schema.Struct({
  before: IsoDateTime,
});
export type DeleteProviderUsageReadingsBeforeInput =
  typeof DeleteProviderUsageReadingsBeforeInput.Type;

export interface ProviderUsageReadingRepositoryShape {
  /**
   * Append readings, ignoring any `readingId` already stored.
   *
   * Idempotent by construction: ids derive from the runtime event id plus the
   * window id, so a replayed event re-appends nothing.
   */
  readonly append: (
    rows: ReadonlyArray<ProviderUsageReading>,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Readings in ascending `capturedAt` order, oldest first. */
  readonly list: (
    input: ListProviderUsageReadingsInput,
  ) => Effect.Effect<ReadonlyArray<ProviderUsageReading>, ProjectionRepositoryError>;

  /** Distinct instance ids that have at least one reading. */
  readonly listInstanceIds: () => Effect.Effect<
    ReadonlyArray<ProviderInstanceId>,
    ProjectionRepositoryError
  >;

  /** Drop readings older than a cutoff, so the tape cannot grow without bound. */
  readonly deleteBefore: (
    input: DeleteProviderUsageReadingsBeforeInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProviderUsageReadingRepository extends Context.Service<
  ProviderUsageReadingRepository,
  ProviderUsageReadingRepositoryShape
>()("t3/persistence/Services/ProviderUsageReadings/ProviderUsageReadingRepository") {}
