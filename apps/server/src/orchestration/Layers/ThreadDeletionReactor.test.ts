import { CommandId, EventId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
// The reactor tests run inside Effect, so they use @effect/vitest's runner; the
// two helper tests below stay on the plain one.
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import {
  logCleanupCauseUnlessInterrupted,
  ThreadDeletionReactorLive,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("orchestrator access cleanup", () => {
  const deletedThreadId = ThreadId.make("thread-deleted");
  const keptThreadId = ThreadId.make("thread-kept");

  const threadDeletedEvent = {
    type: "thread.deleted",
    eventId: EventId.make("evt-thread-deleted"),
    aggregateKind: "thread",
    aggregateId: deletedThreadId,
    occurredAt: "2026-08-06T10:00:00.000Z",
    commandId: CommandId.make("cmd-thread-delete"),
    causationEventId: null,
    correlationId: "cmd-thread-delete",
    metadata: {},
    payload: { threadId: deletedThreadId },
  } as unknown as OrchestrationEvent;

  const runReactor = (events: ReadonlyArray<OrchestrationEvent>) =>
    Effect.gen(function* () {
      const reactor = yield* ThreadDeletionReactor;
      yield* reactor.start();
      // `start` forks the stream consumer, and `drain` only waits on the worker
      // queue — so without giving that fiber a chance to run first, drain can
      // return before the event has even been enqueued.
      yield* Effect.sleep("20 millis");
      yield* reactor.drain;
      const settings = yield* ServerSettingsService;
      return yield* settings.getSettings;
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ThreadDeletionReactorLive.pipe(
          // provideMerge, not provide: the test reads the settings service back
          // out to assert on what the reactor wrote.
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(
                OrchestrationEngineService,
                OrchestrationEngineService.of({
                  streamDomainEvents: Stream.fromIterable(events),
                } as unknown as OrchestrationEngineService["Service"]),
              ),
              Layer.succeed(
                ProviderService,
                ProviderService.of({
                  stopSession: () => Effect.void,
                } as unknown as ProviderService["Service"]),
              ),
              Layer.succeed(
                TerminalManager,
                TerminalManager.of({
                  close: () => Effect.void,
                } as unknown as TerminalManager["Service"]),
              ),
              ServerSettingsService.layerTest({
                orchestratorThreadAccess: {
                  [deletedThreadId]: "control",
                  [keptThreadId]: "watch",
                },
              }),
            ),
          ),
        ),
      ),
    );

  effectIt.live("forgets a deleted thread's sharing without touching anyone else's", () =>
    Effect.gen(function* () {
      const settings = yield* runReactor([threadDeletedEvent]);

      // The deleted thread's key is gone rather than set to "none": the thread
      // no longer exists, so there is nothing to keep a setting for.
      expect(settings.orchestratorThreadAccess[deletedThreadId]).toBeUndefined();
      // Every other conversation's sharing survives the single-entry write.
      expect(settings.orchestratorThreadAccess[keptThreadId]).toBe("watch");
    }),
  );

  effectIt.live("leaves sharing alone when nothing was deleted", () =>
    Effect.gen(function* () {
      const settings = yield* runReactor([]);

      expect(settings.orchestratorThreadAccess[deletedThreadId]).toBe("control");
      expect(settings.orchestratorThreadAccess[keptThreadId]).toBe("watch");
    }),
  );
});
