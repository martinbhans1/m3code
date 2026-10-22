import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ServerSettings,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";

import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  decideIdleCompaction,
  idleCompactionCommandId,
  isAutomaticTurn,
  makeIdleCompaction,
} from "./IdleCompaction.ts";

const THREAD_ID = ThreadId.make("thread-1");
const TURN_ID = TurnId.make("turn-1");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const HOUR_MS = 60 * 60_000;
// Fixed epoch so timestamps read like real ones in failures.
const T0 = Date.parse("2026-10-22T10:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

function makeThread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Long thread",
    modelSelection: { instanceId: CLAUDE, model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: TURN_ID,
      state: "completed",
      requestedAt: iso(T0),
      startedAt: iso(T0),
      completedAt: iso(T0),
      assistantMessageId: null,
    },
    createdAt: iso(T0),
    updatedAt: iso(T0),
    archivedAt: null,
    pinnedAt: null,
    doneAt: null,
    session: {
      threadId: THREAD_ID,
      status: "ready",
      providerName: "claudeAgent",
      providerInstanceId: CLAUDE,
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: iso(T0),
    },
    latestUserMessageAt: iso(T0),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasPendingFollowups: false,
    hasActionableProposedPlan: false,
    handoffThreadId: null,
    sourceThreadId: null,
    ...overrides,
  } as OrchestrationThreadShell;
}

function makeUsage(overrides: Partial<ThreadTokenUsageSnapshot> = {}): ThreadTokenUsageSnapshot {
  return {
    usedTokens: 250_000,
    promptCacheTtlMs: HOUR_MS,
    promptCacheExpiresAt: iso(T0 + HOUR_MS),
    ...overrides,
  };
}

const eligible = {
  thread: makeThread(),
  turnId: TURN_ID,
  mode: "beforeCacheExpires" as const,
  userTurn: { text: "Refactor the parser", commandId: "client:1" },
  usage: { turnId: TURN_ID, usage: makeUsage() },
  nowMs: T0,
};

describe("decideIdleCompaction", () => {
  it("compacts two minutes before a one-hour cache expires", () => {
    expect(decideIdleCompaction(eligible)).toEqual({
      compact: true,
      atMs: T0 + HOUR_MS - 2 * 60_000,
    });
  });

  it("compacts at once when already inside the lead window", () => {
    const nowMs = T0 + HOUR_MS - 60_000;
    expect(decideIdleCompaction({ ...eligible, nowMs })).toEqual({ compact: true, atMs: nowMs });
  });

  const skips: ReadonlyArray<
    [string, Partial<Parameters<typeof decideIdleCompaction>[0]>, string]
  > = [
    ["the setting is off", { mode: "off" }, "disabled"],
    ["the thread is gone", { thread: null }, "thread_unavailable"],
    [
      "the thread is archived",
      { thread: makeThread({ archivedAt: iso(T0) }) },
      "thread_unavailable",
    ],
    ["the thread is marked done", { thread: makeThread({ doneAt: iso(T0) }) }, "thread_done"],
    [
      "the thread is not on Claude",
      {
        thread: makeThread({
          session: { ...makeThread().session!, providerName: "codex" },
        }),
      },
      "not_claude",
    ],
    [
      "the thread moved to another provider instance",
      {
        thread: makeThread({
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        }),
      },
      "model_changed",
    ],
    [
      "the thread moved to another Claude model",
      { userTurn: { text: "hi", commandId: null, model: "claude-sonnet-5" } },
      "model_changed",
    ],
    ["a newer turn exists", { turnId: TurnId.make("turn-0") }, "turn_superseded"],
    [
      "the turn did not complete",
      { thread: makeThread({ latestTurn: { ...makeThread().latestTurn!, state: "error" } }) },
      "turn_not_completed",
    ],
    [
      "a turn is running",
      {
        thread: makeThread({
          session: { ...makeThread().session!, status: "running", activeTurnId: TURN_ID },
        }),
      },
      "busy",
    ],
    [
      "an approval is pending",
      { thread: makeThread({ hasPendingApprovals: true }) },
      "awaiting_approval",
    ],
    [
      "a question is pending",
      { thread: makeThread({ hasPendingUserInput: true }) },
      "awaiting_user_input",
    ],
    [
      "a plan is waiting for review",
      { thread: makeThread({ hasActionableProposedPlan: true }) },
      "awaiting_plan_review",
    ],
    [
      "the turn was a /compact",
      { userTurn: { text: " /compact ", commandId: null } },
      "automatic_turn",
    ],
    [
      "the turn was an auto-resume",
      { userTurn: { text: "[Automatic resume]", commandId: "auto-resume:abc" } },
      "automatic_turn",
    ],
    ["the turn was never seen starting", { userTurn: undefined }, "automatic_turn"],
    ["no usage was reported", { usage: undefined }, "no_usage"],
    [
      "the usage belongs to an earlier turn",
      { usage: { turnId: "turn-0", usage: makeUsage() } },
      "no_usage",
    ],
    [
      "the context is under 200K",
      { usage: { turnId: TURN_ID, usage: makeUsage({ usedTokens: 199_999 }) } },
      "small_context",
    ],
    [
      "the cache is the five-minute one",
      {
        usage: {
          turnId: TURN_ID,
          usage: makeUsage({
            promptCacheTtlMs: 5 * 60_000,
            promptCacheExpiresAt: iso(T0 + 300_000),
          }),
        },
      },
      "short_cache",
    ],
    [
      "the cache TTL is unknown",
      { usage: { turnId: TURN_ID, usage: { usedTokens: 250_000 } } },
      "short_cache",
    ],
    ["the cache already expired", { nowMs: T0 + HOUR_MS }, "cache_expired"],
  ];

  for (const [name, override, reason] of skips) {
    it(`skips when ${name}`, () => {
      expect(decideIdleCompaction({ ...eligible, ...override })).toEqual({
        compact: false,
        reason,
      });
    });
  }
});

describe("isAutomaticTurn", () => {
  it("recognises the turns the app sends itself", () => {
    expect(isAutomaticTurn({ text: "/compact", commandId: null })).toBe(true);
    expect(isAutomaticTurn({ text: "/COMPACT keep the plan", commandId: null })).toBe(true);
    expect(
      isAutomaticTurn({ text: "anything", commandId: idleCompactionCommandId(THREAD_ID, TURN_ID) }),
    ).toBe(true);
    expect(isAutomaticTurn({ text: "anything", commandId: "auto-resume:1" })).toBe(true);
    expect(isAutomaticTurn({ text: "compact the css", commandId: "client:1" })).toBe(false);
  });
});

// ── Scheduling ────────────────────────────────────────────────────────

let sequence = 0;
function event<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  commandId: string | null = null,
): OrchestrationEvent {
  sequence += 1;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: iso(T0),
    commandId: commandId === null ? null : CommandId.make(commandId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
  } as OrchestrationEvent;
}

const userMessage = (text: string, commandId = "client:1") =>
  event(
    "thread.message-sent",
    {
      threadId: THREAD_ID,
      messageId: MessageId.make(`message-${sequence + 1}`),
      role: "user",
      text,
      turnId: null,
      replyToMessageId: null,
      streaming: false,
      createdAt: iso(T0),
      updatedAt: iso(T0),
    },
    commandId,
  );

const sessionSet = (turnId: TurnId | null, status: "running" | "ready" | "stopped") =>
  event("thread.session-set", {
    threadId: THREAD_ID,
    session: { ...makeThread().session!, status, activeTurnId: turnId },
  });

const usageActivity = (turnId: TurnId, usage: ThreadTokenUsageSnapshot) =>
  event("thread.activity-appended", {
    threadId: THREAD_ID,
    activity: {
      id: EventId.make(`activity-${sequence + 1}`),
      tone: "info",
      kind: "context-window.updated",
      summary: "Context window updated",
      payload: usage,
      turnId,
      createdAt: iso(T0),
    },
  });

/** One full turn as the event stream reports it, ending with the session settling. */
const completedTurn = (turnId: TurnId, text: string, usage: ThreadTokenUsageSnapshot) => [
  userMessage(text),
  sessionSet(turnId, "running"),
  usageActivity(turnId, usage),
  sessionSet(null, "ready"),
];

const withIdleCompaction = (input: {
  readonly thread: Ref.Ref<OrchestrationThreadShell>;
  readonly settings?: ServerSettings;
}) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<Array<OrchestrationCommand>>([]);
    const idleCompaction = yield* makeIdleCompaction.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ServerSettingsService, {
            getSettings: Effect.succeed(
              input.settings ?? {
                ...DEFAULT_SERVER_SETTINGS,
                compactIdleThreads: "beforeCacheExpires",
              },
            ),
          } as unknown as ServerSettingsService["Service"]),
          Layer.succeed(ProjectionSnapshotQuery, {
            getThreadShellById: () => Ref.get(input.thread).pipe(Effect.map(Option.some)),
          } as unknown as ProjectionSnapshotQuery["Service"]),
          Layer.succeed(OrchestrationEngineService, {
            dispatch: (command: OrchestrationCommand) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.as({ sequence: 1 }),
              ),
          } as unknown as OrchestrationEngineService["Service"]),
        ),
      ),
    );
    const feed = (events: ReadonlyArray<OrchestrationEvent>) =>
      Effect.forEach(events, idleCompaction.handleEvent, { discard: true });
    return { ...idleCompaction, feed, dispatched: Ref.get(dispatched) };
  });

describe("IdleCompaction scheduling", () => {
  effectIt.effect("sends /compact as a turn shortly before the cache expires", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const thread = yield* Ref.make(makeThread());
        const harness = yield* withIdleCompaction({ thread });

        yield* harness.feed(completedTurn(TURN_ID, "Refactor the parser", makeUsage()));
        expect(yield* harness.isScheduled(THREAD_ID)).toBe(true);

        yield* TestClock.adjust(Duration.minutes(57));
        expect(yield* harness.dispatched).toEqual([]);

        yield* TestClock.adjust(Duration.minutes(1));
        const commands = yield* harness.dispatched;
        expect(commands).toHaveLength(1);
        expect(commands[0]).toMatchObject({
          type: "thread.turn.start",
          commandId: "idle-compact:thread-1:turn-1",
          threadId: THREAD_ID,
          message: { messageId: "idle-compact:thread-1:turn-1", role: "user", text: "/compact" },
          modelSelection: { instanceId: CLAUDE, model: "claude-opus-5-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
      }),
    ),
  );

  effectIt.effect("a newer completed turn replaces the waiting timer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const thread = yield* Ref.make(makeThread());
        const harness = yield* withIdleCompaction({ thread });
        yield* harness.feed(completedTurn(TURN_ID, "first", makeUsage()));

        yield* TestClock.adjust(Duration.minutes(30));
        const turn2 = TurnId.make("turn-2");
        const now = T0 + 30 * 60_000;
        yield* Ref.update(thread, (current) =>
          makeThread({ latestTurn: { ...current.latestTurn!, turnId: turn2 } }),
        );
        yield* harness.feed(
          completedTurn(turn2, "second", makeUsage({ promptCacheExpiresAt: iso(now + HOUR_MS) })),
        );

        // The first turn's window passes without a compaction…
        yield* TestClock.adjust(Duration.minutes(29));
        expect(yield* harness.dispatched).toEqual([]);
        // …and the second turn's fires once.
        yield* TestClock.adjust(Duration.minutes(30));
        const commands = yield* harness.dispatched;
        expect(commands.map((command) => command.commandId)).toEqual([
          "idle-compact:thread-1:turn-2",
        ]);
      }),
    ),
  );

  effectIt.effect("a new user message cancels the waiting compaction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const thread = yield* Ref.make(makeThread());
        const harness = yield* withIdleCompaction({ thread });
        yield* harness.feed(completedTurn(TURN_ID, "first", makeUsage()));
        yield* harness.feed([userMessage("one more thing")]);
        expect(yield* harness.isScheduled(THREAD_ID)).toBe(false);
        yield* TestClock.adjust(Duration.hours(2));
        expect(yield* harness.dispatched).toEqual([]);
      }),
    ),
  );

  effectIt.effect("the idle reaper stopping the session keeps the timer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const thread = yield* Ref.make(makeThread());
        const harness = yield* withIdleCompaction({ thread });
        yield* harness.feed(completedTurn(TURN_ID, "first", makeUsage()));
        yield* TestClock.adjust(Duration.minutes(30));
        yield* harness.feed([sessionSet(null, "stopped")]);
        expect(yield* harness.isScheduled(THREAD_ID)).toBe(true);
      }),
    ),
  );

  effectIt.effect("re-checks the thread when the timer fires", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const thread = yield* Ref.make(makeThread());
        const harness = yield* withIdleCompaction({ thread });
        yield* harness.feed(completedTurn(TURN_ID, "first", makeUsage()));
        // Answering nothing yet, the thread now waits on an approval.
        yield* Ref.update(thread, (current) => ({ ...current, hasPendingApprovals: true }));
        yield* TestClock.adjust(Duration.hours(1));
        expect(yield* harness.dispatched).toEqual([]);
      }),
    ),
  );

  effectIt.effect("never compacts after its own compaction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const thread = yield* Ref.make(makeThread());
        const harness = yield* withIdleCompaction({ thread });
        const commandId = idleCompactionCommandId(THREAD_ID, TURN_ID);
        yield* harness.feed([
          userMessage("/compact", commandId),
          sessionSet(TURN_ID, "running"),
          usageActivity(TURN_ID, makeUsage()),
          sessionSet(null, "ready"),
        ]);
        expect(yield* harness.isScheduled(THREAD_ID)).toBe(false);
      }),
    ),
  );

  effectIt.effect("schedules nothing while the setting is off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const thread = yield* Ref.make(makeThread());
        const harness = yield* withIdleCompaction({ thread, settings: DEFAULT_SERVER_SETTINGS });
        yield* harness.feed(completedTurn(TURN_ID, "first", makeUsage()));
        expect(yield* harness.isScheduled(THREAD_ID)).toBe(false);
      }),
    ),
  );

  effectIt.effect("archiving the thread cancels the timer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const thread = yield* Ref.make(makeThread());
        const harness = yield* withIdleCompaction({ thread });
        yield* harness.feed(completedTurn(TURN_ID, "first", makeUsage()));
        yield* harness.feed([
          event("thread.archived", {
            threadId: THREAD_ID,
            archivedAt: iso(T0),
            updatedAt: iso(T0),
          } as never),
        ]);
        expect(yield* harness.isScheduled(THREAD_ID)).toBe(false);
      }),
    ),
  );
});
