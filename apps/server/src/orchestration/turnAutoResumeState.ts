/**
 * TurnAutoResumeState - Persisted bookkeeping for restart-resilient turns.
 *
 * Provider sessions are children of this process, so quitting the app (an
 * update, a reinstall, a crash) kills every turn that was mid-flight. The
 * conversation itself survives — messages live in the projection and the
 * provider keeps a resume cursor — so the work can be picked back up on the
 * next boot instead of silently sitting half-finished.
 *
 * Two pieces of state make that safe:
 *
 * - `inFlight`: threads that were actively running a turn when the process
 *   went away, captured on shutdown so a graceful stop is distinguishable
 *   from a turn the user deliberately interrupted.
 * - `history`: how many times in a row a thread has been auto-resumed without
 *   the user saying anything in between, so a crash loop can't append
 *   "continue" forever.
 *
 * @module TurnAutoResumeState
 */
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";

/**
 * A thread that was mid-turn when the process shut down.
 */
export const TurnAutoResumeInFlightEntry = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.NullOr(Schema.String),
  capturedAt: Schema.String,
});
export type TurnAutoResumeInFlightEntry = typeof TurnAutoResumeInFlightEntry.Type;

/**
 * How many consecutive auto-resumes a thread has received, and when the last
 * one was sent. `lastAutoResumeAt` doubles as the identity of the resume
 * message: it is the exact `createdAt` of the user message we injected, so
 * comparing it against the thread's `latestUserMessageAt` says whether the
 * user has spoken since.
 */
export const TurnAutoResumeHistoryEntry = Schema.Struct({
  threadId: ThreadId,
  consecutiveAutoResumes: Schema.Int,
  lastAutoResumeAt: Schema.String,
});
export type TurnAutoResumeHistoryEntry = typeof TurnAutoResumeHistoryEntry.Type;

export const PersistedTurnAutoResumeState = Schema.Struct({
  version: Schema.Literal(1),
  /**
   * When the previous process started its boot scan. Dates the evidence: work
   * belonging to the run that just died happened after this, and anything older
   * is an orphaned turn row from some earlier crash, not live work.
   *
   * Optional so a state file written before this field existed still decodes;
   * a missing value means "cannot date the evidence", and nothing is resumed.
   */
  bootedAt: Schema.optional(Schema.String),
  inFlight: Schema.Array(TurnAutoResumeInFlightEntry),
  history: Schema.Array(TurnAutoResumeHistoryEntry),
});
export type PersistedTurnAutoResumeState = typeof PersistedTurnAutoResumeState.Type;

export const emptyTurnAutoResumeState: PersistedTurnAutoResumeState = {
  version: 1,
  inFlight: [],
  history: [],
};

const decodePersistedTurnAutoResumeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedTurnAutoResumeState),
);

export const readTurnAutoResumeState = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return emptyTurnAutoResumeState;
    }

    const raw = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return emptyTurnAutoResumeState;
    }

    // A malformed file must never keep the server from booting; the worst case
    // of dropping it is that one restart does not auto-resume.
    return yield* decodePersistedTurnAutoResumeState(trimmed).pipe(
      Effect.option,
      Effect.map(Option.getOrElse(() => emptyTurnAutoResumeState)),
    );
  });

export const writeTurnAutoResumeState = (input: {
  readonly path: string;
  readonly state: PersistedTurnAutoResumeState;
}) =>
  writeFileStringAtomically({
    filePath: input.path,
    contents: `${JSON.stringify(input.state)}\n`,
  });
