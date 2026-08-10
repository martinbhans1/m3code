// @effect-diagnostics nodeBuiltinImport:off
import {
  CommandId,
  TurnId,
  type OrchestrationThreadShell,
  defaultInstanceIdForDriver,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";
import { deriveServerPaths, ServerConfig } from "../src/config.ts";
import { makeTurnAutoResume } from "../src/orchestration/Layers/TurnAutoResume.ts";
import {
  readTurnAutoResumeState,
  writeTurnAutoResumeState,
} from "../src/orchestration/turnAutoResumeState.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../src/provider/Services/ProviderSessionDirectory.ts";
import { ServerRuntimeStartup } from "../src/serverRuntimeStartup.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const PROVIDER = ProviderDriverKind.make("codex");
const FIXTURE_TURN_ID = "fixture-turn";

const NOW = "2026-08-06T00:00:00.000Z";
const PREVIOUS_BOOT_AT = "2026-08-05T00:00:00.000Z";

function withHarness<A, E>(use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider: PROVIDER }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

const seedProjectAndThread = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const provider = harness.adapterHarness?.provider ?? PROVIDER;
    const instanceId = defaultInstanceIdForDriver(provider);
    const model = DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;

    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project-create"),
      projectId: PROJECT_ID,
      title: "Auto Resume Project",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: { instanceId, model },
      createdAt: NOW,
    });

    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Auto Resume Thread",
      modelSelection: { instanceId, model },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt: NOW,
    });
  });

/**
 * A turn that starts and streams, but never reports completion — the shape of
 * a turn that was still working when the process went away.
 */
const unfinishedTurnResponse = (idPrefix: string) => ({
  events: [
    {
      type: "turn.started" as const,
      eventId: EventId.make(`${idPrefix}-1`),
      provider: PROVIDER,
      createdAt: NOW,
      threadId: THREAD_ID,
      turnId: FIXTURE_TURN_ID,
    },
    {
      type: "message.delta" as const,
      eventId: EventId.make(`${idPrefix}-2`),
      provider: PROVIDER,
      createdAt: NOW,
      threadId: THREAD_ID,
      turnId: FIXTURE_TURN_ID,
      delta: "Working on it",
    },
  ],
});

const readState = (statePath: string) =>
  readTurnAutoResumeState(statePath).pipe(Effect.provide(NodeServices.layer));

const autoResumeStatePath = (harness: OrchestrationIntegrationHarness) =>
  deriveServerPaths(harness.rootDir, undefined).pipe(
    Effect.map((paths) => paths.turnAutoResumeStatePath),
    Effect.provide(NodeServices.layer),
  );

/**
 * The auto-resume service wired to the harness's real engine and projection,
 * with only the process-lifecycle collaborators stubbed.
 */
const runningThreadShell = (base: OrchestrationThreadShell): OrchestrationThreadShell => ({
  ...base,
  latestTurn: {
    turnId: TurnId.make(FIXTURE_TURN_ID),
    state: "running",
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: null,
    assistantMessageId: null,
  },
});

const makeAutoResumeForHarness = (
  harness: OrchestrationIntegrationHarness,
  snapshotOverride?: ProjectionSnapshotQuery["Service"],
) =>
  makeTurnAutoResume.pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(harness.workspaceDir, harness.rootDir),
        Layer.succeed(ProjectionSnapshotQuery, snapshotOverride ?? harness.snapshotQuery),
        Layer.succeed(OrchestrationEngineService, harness.engine),
        Layer.succeed(ServerRuntimeStartup, {
          awaitCommandReady: Effect.void,
          markHttpListening: Effect.void,
          enqueueCommand: (effect) => effect,
        } as ServerRuntimeStartup["Service"]),
        Layer.succeed(ProviderSessionDirectory, {
          listBindings: () => Effect.succeed([]),
        } as unknown as ProviderSessionDirectory["Service"]),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    // The returned operations still touch the filesystem when they run, so the
    // platform services have to be provided to them as well as to the factory.
    Effect.map((autoResume) => ({
      captureInFlightTurns: autoResume.captureInFlightTurns.pipe(
        Effect.provide(NodeServices.layer),
      ),
      resumeInterruptedTurns: autoResume.resumeInterruptedTurns.pipe(
        Effect.provide(NodeServices.layer),
      ),
    })),
  );

it.live("dispatches a real resume turn for a thread captured as in-flight", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      // Stand in for the previous process's shutdown capture: this thread was
      // working when the app went away.
      const statePath = yield* autoResumeStatePath(harness);
      yield* writeTurnAutoResumeState({
        path: statePath,
        state: {
          version: 1,
          // The run that died started before the thread was touched, so the
          // captured evidence dates to that run rather than an older crash.
          bootedAt: PREVIOUS_BOOT_AT,
          inFlight: [{ threadId: THREAD_ID, turnId: FIXTURE_TURN_ID, capturedAt: NOW }],
          history: [],
        },
      }).pipe(Effect.provide(NodeServices.layer));

      // Boot: the resumed turn goes out over the real decider and provider.
      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started" as const,
            eventId: EventId.make("evt-resumed-1"),
            provider: PROVIDER,
            createdAt: NOW,
            threadId: THREAD_ID,
            turnId: "resumed-turn",
          },
          {
            type: "message.delta" as const,
            eventId: EventId.make("evt-resumed-2"),
            provider: PROVIDER,
            createdAt: NOW,
            threadId: THREAD_ID,
            turnId: "resumed-turn",
            delta: "Picking up where I left off",
          },
          {
            type: "turn.completed" as const,
            eventId: EventId.make("evt-resumed-3"),
            provider: PROVIDER,
            createdAt: NOW,
            threadId: THREAD_ID,
            turnId: "resumed-turn",
            status: "completed" as const,
          },
        ],
      });

      // The fake adapter always settles its turns, so a genuinely mid-turn
      // projection cannot be produced here. The snapshot is stubbed to the
      // shape a killed turn leaves behind; everything downstream of the
      // decision — command, decider, provider, projection — stays real.
      const shell = yield* harness.snapshotQuery
        .getThreadShellById(THREAD_ID)
        .pipe(Effect.map((option) => (option._tag === "Some" ? option.value : null)));
      assert.isNotNull(shell);
      const snapshotOverride = {
        ...harness.snapshotQuery,
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: [],
            threads: [runningThreadShell(shell!)],
            updatedAt: NOW,
          }),
      } as unknown as ProjectionSnapshotQuery["Service"];

      const autoResume = yield* makeAutoResumeForHarness(harness, snapshotOverride);
      yield* autoResume.resumeInterruptedTurns;

      const resumed = yield* harness.waitForThread(
        THREAD_ID,
        (thread) =>
          thread.latestTurn?.state === "completed" &&
          thread.messages.some(
            (message) =>
              message.role === "assistant" && message.text.includes("Picking up where I left off"),
          ),
      );

      const userMessages = resumed.messages.filter((message) => message.role === "user");
      assert.strictEqual(userMessages.length, 1);
      assert.isTrue(
        userMessages[0]?.text.startsWith("[Automatic resume after app restart]"),
        "the resume turn is sent as a visible user message",
      );
      assert.strictEqual(resumed.latestTurn?.state, "completed");

      const state = yield* readState(statePath);
      assert.deepStrictEqual(state.inFlight, []);
      assert.strictEqual(state.history.length, 1);
      assert.strictEqual(state.history[0]?.threadId, THREAD_ID);
      assert.strictEqual(state.history[0]?.consecutiveAutoResumes, 1);
    }),
  ),
);

it.live("leaves a settled thread alone across a restart", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          ...unfinishedTurnResponse("evt-settled").events,
          {
            type: "turn.completed" as const,
            eventId: EventId.make("evt-settled-3"),
            provider: PROVIDER,
            createdAt: NOW,
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed" as const,
          },
        ],
      });
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-settled"),
        threadId: THREAD_ID,
        message: {
          messageId: MessageId.make("msg-user-settled"),
          role: "user",
          text: "Say hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: NOW,
      });

      yield* harness.waitForThread(THREAD_ID, (thread) => thread.latestTurn?.state === "completed");

      const autoResume = yield* makeAutoResumeForHarness(harness);
      yield* autoResume.captureInFlightTurns;
      yield* autoResume.resumeInterruptedTurns;

      const thread = yield* harness.snapshotQuery
        .getThreadShellById(THREAD_ID)
        .pipe(Effect.map((option) => (option._tag === "Some" ? option.value : null)));
      assert.isNotNull(thread);

      const snapshot = yield* harness.waitForThread(THREAD_ID, () => true);
      assert.strictEqual(
        snapshot.messages.filter((message) => message.role === "user").length,
        1,
        "a finished thread must not be given a resume message",
      );
    }),
  ),
);
