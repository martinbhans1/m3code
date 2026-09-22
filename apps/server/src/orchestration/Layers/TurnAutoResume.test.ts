// @effect-diagnostics nodeBuiltinImport:off
import os from "node:os";
import path from "node:path";

import {
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { describe, expect, it } from "vite-plus/test";

import { decideAutoResume, hasUnsettledTurn, makeTurnAutoResume } from "./TurnAutoResume.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import {
  readTurnAutoResumeState,
  writeTurnAutoResumeState,
  type TurnAutoResumeHistoryEntry,
} from "../turnAutoResumeState.ts";

const RESUME_AT = "2026-08-06T10:00:00.000Z";

function makeThread(overrides: {
  readonly turnState?: "running" | "completed" | "interrupted" | "error";
  readonly sessionStatus?: OrchestrationThreadShell["session"] extends infer S
    ? S extends { status: infer T }
      ? T
      : never
    : never;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly latestUserMessageAt?: string | null;
  readonly updatedAt?: string;
}): OrchestrationThreadShell {
  const turnState = overrides.turnState ?? "completed";
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Some work",
    modelSelection: { provider: "claude", model: "claude-opus-5" },
    runtimeMode: "local",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: turnState,
      requestedAt: RESUME_AT,
      startedAt: RESUME_AT,
      completedAt: turnState === "running" ? null : RESUME_AT,
      assistantMessageId: MessageId.make("message-1"),
    },
    createdAt: RESUME_AT,
    updatedAt: overrides.updatedAt ?? RESUME_AT,
    archivedAt: null,
    pinnedAt: null,
    doneAt: null,
    session:
      overrides.sessionStatus === undefined
        ? null
        : {
            threadId: ThreadId.make("thread-1"),
            status: overrides.sessionStatus,
            providerName: "claude",
            runtimeMode: "local",
            activeTurnId: overrides.sessionStatus === "running" ? TurnId.make("turn-1") : null,
            lastError: null,
            updatedAt: RESUME_AT,
          },
    latestUserMessageAt: overrides.latestUserMessageAt ?? RESUME_AT,
    hasPendingApprovals: overrides.hasPendingApprovals ?? false,
    hasPendingUserInput: overrides.hasPendingUserInput ?? false,
    hasPendingFollowups: false,
    hasActionableProposedPlan: false,
  } as unknown as OrchestrationThreadShell;
}

const history = (input: {
  readonly consecutiveAutoResumes: number;
  readonly lastAutoResumeAt: string;
}): TurnAutoResumeHistoryEntry => ({
  threadId: ThreadId.make("thread-1"),
  consecutiveAutoResumes: input.consecutiveAutoResumes,
  lastAutoResumeAt: input.lastAutoResumeAt,
});

describe("hasUnsettledTurn", () => {
  it("counts only a turn still marked running", () => {
    expect(hasUnsettledTurn(makeThread({ turnState: "running" }))).toBe(true);
    // Every settled state means the user already got an answer of some kind,
    // including the unhappy ones.
    expect(hasUnsettledTurn(makeThread({ turnState: "completed" }))).toBe(false);
    expect(hasUnsettledTurn(makeThread({ turnState: "error" }))).toBe(false);
    expect(hasUnsettledTurn(makeThread({ turnState: "interrupted" }))).toBe(false);
  });
});

const PREVIOUS_BOOT_AT = "2026-08-06T09:00:00.000Z";

const NOW = "2026-08-06T10:05:00.000Z";

/** The provider was working on the thread's open turn, moments before the kill. */
const liveEvidence = {
  activeTurnId: "turn-1",
  lastSeenAt: "2026-08-06T09:30:00.000Z",
};

const decide = (overrides: {
  readonly thread?: OrchestrationThreadShell;
  readonly wasCapturedInFlight?: boolean;
  readonly evidence?: {
    readonly activeTurnId: string | null;
    readonly lastSeenAt: string | null;
    readonly ownerLiveness?: "self" | "live" | "gone" | "unknown";
  };
  readonly history?: TurnAutoResumeHistoryEntry | undefined;
  readonly previousBootAt?: string | null;
  readonly hasLiveSiblingBackend?: boolean;
}) =>
  decideAutoResume({
    thread: overrides.thread ?? makeThread({ turnState: "running" }),
    wasCapturedInFlight: overrides.wasCapturedInFlight ?? false,
    evidence: overrides.evidence ?? liveEvidence,
    history: overrides.history,
    hasLiveSiblingBackend: overrides.hasLiveSiblingBackend ?? false,
    previousBootAt:
      overrides.previousBootAt === undefined ? PREVIOUS_BOOT_AT : overrides.previousBootAt,
    now: NOW,
  });

describe("decideAutoResume", () => {
  it("resumes a thread the provider was still running a turn for", () => {
    expect(decide({})).toEqual({ resume: true, consecutiveAutoResumes: 0 });
  });

  it("resumes a thread the shutdown captured, even without provider evidence", () => {
    expect(
      decide({
        wasCapturedInFlight: true,
        evidence: { activeTurnId: null, lastSeenAt: "2026-08-06T09:30:00.000Z" },
      }),
    ).toEqual({ resume: true, consecutiveAutoResumes: 0 });
  });

  it("leaves a turn alone while the backend that started it is still running", () => {
    // The bug this exists for: a second backend boots against the same data
    // directory, reads the first one's in-flight turn as its own orphan, and
    // resumes it into a conversation the provider still has open.
    expect(decide({ evidence: { ...liveEvidence, ownerLiveness: "live" } })).toEqual({
      resume: false,
      reason: "session_owned_by_live_backend",
    });
    // Even the shutdown capture cannot argue with a live owner: whatever it
    // recorded was recorded about a process that has since exited.
    expect(
      decide({
        wasCapturedInFlight: true,
        evidence: { ...liveEvidence, ownerLiveness: "live" },
      }),
    ).toEqual({ resume: false, reason: "session_owned_by_live_backend" });
  });

  it("resumes once the backend that owned the session is gone", () => {
    expect(decide({ evidence: { ...liveEvidence, ownerLiveness: "gone" } })).toEqual({
      resume: true,
      consecutiveAutoResumes: 0,
    });
  });

  it("still resumes a session written before sessions carried an owner", () => {
    expect(decide({ evidence: { ...liveEvidence, ownerLiveness: "unknown" } })).toEqual({
      resume: true,
      consecutiveAutoResumes: 0,
    });
  });

  it("will not claim an unowned session while another backend shares the directory", () => {
    // Until every backend on this directory stamps its sessions, an unowned row
    // may well be the neighbour's live work - as it was on 2026-09-17, where
    // the installed app had not been rebuilt yet.
    expect(
      decide({
        evidence: { ...liveEvidence, ownerLiveness: "unknown" },
        hasLiveSiblingBackend: true,
      }),
    ).toEqual({ resume: false, reason: "session_owner_unknown_while_sharing" });
  });

  it("still resumes its own dead session while sharing the directory", () => {
    expect(
      decide({
        evidence: { ...liveEvidence, ownerLiveness: "gone" },
        hasLiveSiblingBackend: true,
      }),
    ).toEqual({ resume: true, consecutiveAutoResumes: 0 });
  });

  it("ignores an open turn the provider was not actually working on", () => {
    // `activeTurnId` is never cleared, so once a turn ends it keeps naming that
    // finished turn. Only a match against the open turn means live work.
    expect(decide({ evidence: { activeTurnId: "some-older-turn", lastSeenAt: NOW } })).toEqual({
      resume: false,
      reason: "provider_turn_mismatch",
    });
  });

  it("ignores evidence older than the previous boot", () => {
    expect(
      decide({
        thread: makeThread({ turnState: "running", updatedAt: "2026-08-06T08:00:00.000Z" }),
        evidence: { activeTurnId: "turn-1", lastSeenAt: "2026-08-06T08:00:00.000Z" },
      }),
    ).toEqual({ resume: false, reason: "stale_evidence" });
  });

  it("ignores a turn row orphaned long ago even with no boot marker to compare", () => {
    // The June zombies: turn still open, provider still naming it, weeks stale.
    expect(
      decide({
        thread: makeThread({ turnState: "running", updatedAt: "2026-06-26T08:48:42.000Z" }),
        evidence: { activeTurnId: "turn-1", lastSeenAt: "2026-06-26T08:45:44.000Z" },
        previousBootAt: null,
      }),
    ).toEqual({ resume: false, reason: "stale_evidence" });
  });

  it("still resumes recent work when no boot marker exists yet", () => {
    expect(decide({ previousBootAt: null })).toEqual({
      resume: true,
      consecutiveAutoResumes: 0,
    });
  });

  it("leaves a settled thread alone, however it settled", () => {
    // Including a turn that failed: an expired login answered the user with an
    // error, so there is nothing in flight to pick back up.
    for (const turnState of ["completed", "error", "interrupted"] as const) {
      expect(decide({ thread: makeThread({ turnState }) })).toEqual({
        resume: false,
        reason: "turn_settled",
      });
    }
  });

  it("leaves threads blocked on the user alone", () => {
    expect(
      decide({ thread: makeThread({ turnState: "running", hasPendingApprovals: true }) }),
    ).toEqual({ resume: false, reason: "awaiting_approval" });

    expect(
      decide({ thread: makeThread({ turnState: "running", hasPendingUserInput: true }) }),
    ).toEqual({ resume: false, reason: "awaiting_user_input" });
  });

  it("counts consecutive resumes while the injected message is still the newest user message", () => {
    expect(
      decide({
        thread: makeThread({ turnState: "running", latestUserMessageAt: RESUME_AT }),
        history: history({ consecutiveAutoResumes: 2, lastAutoResumeAt: RESUME_AT }),
      }),
    ).toEqual({ resume: true, consecutiveAutoResumes: 2 });
  });

  it("stops after three consecutive auto-resumes rather than looping forever", () => {
    expect(
      decide({
        thread: makeThread({ turnState: "running", latestUserMessageAt: RESUME_AT }),
        history: history({ consecutiveAutoResumes: 3, lastAutoResumeAt: RESUME_AT }),
      }),
    ).toEqual({ resume: false, reason: "resume_limit_reached" });
  });

  it("resets the counter once the user has said something since the last resume", () => {
    expect(
      decide({
        thread: makeThread({
          turnState: "running",
          latestUserMessageAt: "2026-08-06T11:00:00.000Z",
        }),
        history: history({ consecutiveAutoResumes: 3, lastAutoResumeAt: RESUME_AT }),
      }),
    ).toEqual({ resume: true, consecutiveAutoResumes: 0 });
  });
});

/**
 * Exercise the shutdown capture and boot bookkeeping against stub services:
 * the projection and engine are the only collaborators that matter here, and a
 * real one of either would drag a database in for no extra coverage.
 */
const withAutoResume = (input: {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly statePath: string;
  readonly bindings?: ReadonlyArray<unknown>;
}) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<Array<OrchestrationCommand>>([]);

    const autoResume = yield* makeTurnAutoResume.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ServerConfig, {
            turnAutoResumeStatePath: input.statePath,
          } as unknown as ServerConfig["Service"]),
          Layer.succeed(ProjectionSnapshotQuery, {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 1,
                projects: [],
                threads: input.threads,
                updatedAt: RESUME_AT,
              }),
          } as unknown as ProjectionSnapshotQuery["Service"]),
          Layer.succeed(OrchestrationEngineService, {
            dispatch: (command: OrchestrationCommand) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.as({ sequence: 1 }),
              ),
          } as unknown as OrchestrationEngineService["Service"]),
          Layer.succeed(ServerRuntimeStartup, {
            awaitCommandReady: Effect.void,
            markHttpListening: Effect.void,
            enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) => effect,
          } as unknown as ServerRuntimeStartup["Service"]),
          Layer.succeed(ProviderSessionDirectory, {
            listBindings: () => Effect.succeed(input.bindings ?? []),
          } as unknown as ProviderSessionDirectory["Service"]),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );

    return {
      captureInFlightTurns: autoResume.captureInFlightTurns.pipe(
        Effect.provide(NodeServices.layer),
      ),
      resumeInterruptedTurns: autoResume.resumeInterruptedTurns.pipe(
        Effect.provide(NodeServices.layer),
      ),
      dispatchedCommands: Ref.get(dispatched),
    };
  });

/** A provider binding that still holds an active turn for the test thread. */
const activeBinding = (lastSeenAt: string) => ({
  threadId: ThreadId.make("thread-1"),
  provider: "claude",
  providerInstanceId: "claude",
  adapterKey: "claude",
  runtimeMode: "local",
  status: "running",
  resumeCursor: null,
  runtimePayload: { activeTurnId: "turn-1" },
  lastSeenAt,
});

/** The same binding, stamped as belonging to a backend process that is up. */
const bindingOwnedByLiveBackend = (lastSeenAt: string) => ({
  ...activeBinding(lastSeenAt),
  runtimePayload: { activeTurnId: "turn-1", ownerPid: process.pid },
});

const tempStatePath = (name: string) =>
  path.join(os.tmpdir(), `t3-turn-auto-resume-${name}-${process.pid}.json`);

const readState = (statePath: string) =>
  readTurnAutoResumeState(statePath).pipe(Effect.provide(NodeServices.layer));

describe("turn auto-resume lifecycle", () => {
  effectIt.effect("records the threads that were mid-turn when the process stops", () =>
    Effect.gen(function* () {
      const statePath = tempStatePath("capture");
      const autoResume = yield* withAutoResume({
        statePath,
        threads: [makeThread({ turnState: "running" })],
        bindings: [activeBinding(RESUME_AT)],
      });

      yield* autoResume.captureInFlightTurns;

      const state = yield* readState(statePath);
      expect(state.inFlight.map((entry) => entry.threadId)).toEqual([ThreadId.make("thread-1")]);
      expect(state.inFlight[0]?.turnId).toBe("turn-1");
    }),
  );

  effectIt.effect("sends one resume turn per interrupted thread and remembers it", () =>
    Effect.gen(function* () {
      const statePath = tempStatePath("resume");
      yield* writeTurnAutoResumeState({
        path: statePath,
        state: {
          version: 1,
          bootedAt: PREVIOUS_BOOT_AT,
          inFlight: [
            { threadId: ThreadId.make("thread-1"), turnId: "turn-1", capturedAt: RESUME_AT },
          ],
          history: [],
        },
      }).pipe(Effect.provide(NodeServices.layer));

      const autoResume = yield* withAutoResume({
        statePath,
        threads: [makeThread({ turnState: "running" })],
        bindings: [activeBinding(RESUME_AT)],
      });

      yield* autoResume.resumeInterruptedTurns;

      const commands = yield* autoResume.dispatchedCommands;
      expect(commands).toHaveLength(1);
      const command = commands[0];
      expect(command?.type).toBe("thread.turn.start");
      if (command?.type === "thread.turn.start") {
        expect(command.message.text).toContain("[Automatic resume after app restart]");
        expect(String(command.commandId)).toMatch(/^auto-resume:/);
      }

      const state = yield* readState(statePath);
      expect(state.inFlight).toEqual([]);
      expect(state.history).toHaveLength(1);
      expect(state.history[0]?.consecutiveAutoResumes).toBe(1);
    }),
  );

  effectIt.effect("does not resurrect a thread orphaned by an earlier crash", () =>
    Effect.gen(function* () {
      const statePath = tempStatePath("stale");
      yield* writeTurnAutoResumeState({
        path: statePath,
        state: { version: 1, bootedAt: PREVIOUS_BOOT_AT, inFlight: [], history: [] },
      }).pipe(Effect.provide(NodeServices.layer));

      // Turn row still says `running` and the provider still holds an active
      // turn id, but both are from June: an orphan, not live work.
      const autoResume = yield* withAutoResume({
        statePath,
        threads: [makeThread({ turnState: "running", updatedAt: "2026-06-26T08:48:42.000Z" })],
        bindings: [activeBinding("2026-06-26T08:45:44.000Z")],
      });

      yield* autoResume.resumeInterruptedTurns;

      expect(yield* autoResume.dispatchedCommands).toEqual([]);
    }),
  );

  effectIt.effect("leaves a conversation another backend is running untouched", () =>
    Effect.gen(function* () {
      const statePath = tempStatePath("live-owner");
      yield* writeTurnAutoResumeState({
        path: statePath,
        state: {
          version: 1,
          bootedAt: PREVIOUS_BOOT_AT,
          inFlight: [
            { threadId: ThreadId.make("thread-1"), turnId: "turn-1", capturedAt: RESUME_AT },
          ],
          history: [],
        },
      }).pipe(Effect.provide(NodeServices.layer));

      // Owned by a process that is demonstrably alive - this one.
      const autoResume = yield* withAutoResume({
        statePath,
        threads: [makeThread({ turnState: "running" })],
        bindings: [bindingOwnedByLiveBackend(RESUME_AT)],
      });

      yield* autoResume.resumeInterruptedTurns;

      expect(yield* autoResume.dispatchedCommands).toEqual([]);
    }),
  );

  effectIt.effect("records this boot so the next one can date its evidence", () =>
    Effect.gen(function* () {
      const statePath = tempStatePath("bootstamp");
      const autoResume = yield* withAutoResume({ statePath, threads: [] });

      yield* autoResume.resumeInterruptedTurns;

      const state = yield* readState(statePath);
      expect(typeof state.bootedAt).toBe("string");
    }),
  );

  effectIt.effect("stops resending once the consecutive-resume ceiling is hit", () =>
    Effect.gen(function* () {
      const statePath = tempStatePath("ceiling");
      yield* writeTurnAutoResumeState({
        path: statePath,
        state: {
          version: 1,
          bootedAt: PREVIOUS_BOOT_AT,
          inFlight: [
            { threadId: ThreadId.make("thread-1"), turnId: "turn-1", capturedAt: RESUME_AT },
          ],
          history: [
            {
              threadId: ThreadId.make("thread-1"),
              consecutiveAutoResumes: 3,
              lastAutoResumeAt: RESUME_AT,
            },
          ],
        },
      }).pipe(Effect.provide(NodeServices.layer));

      const autoResume = yield* withAutoResume({
        statePath,
        threads: [makeThread({ turnState: "running", latestUserMessageAt: RESUME_AT })],
        bindings: [activeBinding(RESUME_AT)],
      });

      yield* autoResume.resumeInterruptedTurns;

      expect(yield* autoResume.dispatchedCommands).toEqual([]);
      const state = yield* readState(statePath);
      expect(state.history).toEqual([]);
    }),
  );
});
