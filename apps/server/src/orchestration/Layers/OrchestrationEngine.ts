import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { OrchestrationCommand } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);

interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  let commandReadModel = createEmptyReadModel(yield* nowIso);

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* () {
      let nextReadModel = baseReadModel;
      for (const event of events) {
        nextReadModel = yield* projectEvent(nextReadModel, event);
      }
      return nextReadModel;
    });

  /**
   * Re-read the command read model from the projection when the event log has
   * moved past what this engine knows.
   *
   * The in-memory model is only ever grown by this engine's own commits, which
   * silently assumes this process is the sole writer of `state.sqlite`. It is
   * not: a dev desktop window shares the installed app's state directory, and
   * the CLI opens the same database. A thread another writer created is then
   * missing from this model forever — not until the next reload, but for the
   * life of the process — and every command naming it is rejected with
   * "Thread '<id>' does not exist", hours after the thread was created and is
   * plainly visible in the UI.
   *
   * The projection tables are the shared source of truth (they are what the
   * model is built from at boot), so re-reading them is exactly a boot-time
   * rehydrate and picks up whatever the other writer committed.
   *
   * Returns whether anything actually moved: when the projection is no further
   * along than the model, the model was not stale and the invariant that sent
   * us here is a real one that must keep failing.
   */
  const refreshCommandReadModelIfStale = Effect.gen(function* () {
    const refreshed = yield* projectionSnapshotQuery.getCommandReadModel();
    if (refreshed.snapshotSequence <= commandReadModel.snapshotSequence) {
      return false;
    }
    commandReadModel = refreshed;
    return true;
  });

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    let processingStartedAtMs = 0;
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      // Read the sequence when the reconcile runs, not when the envelope was
      // picked up: a rehydrate in between already folded in everything the
      // event log holds, and replaying from the older mark would apply those
      // events a second time (streaming message deltas would be appended
      // twice).
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(commandReadModel.snapshotSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      commandReadModel = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents);

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        processingStartedAtMs = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          if (existingReceipt.value.status === "accepted") {
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        const decideAndCommit = Effect.gen(function* () {
          const eventBase = yield* decideOrchestrationCommand({
            command: envelope.command,
            readModel: commandReadModel,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.mapError((cause) =>
              isOrchestrationCommandInvariantError(cause)
                ? cause
                : new OrchestrationCommandInvariantError({
                    commandType: envelope.command.type,
                    detail: "Failed to generate an event identifier.",
                    cause,
                  }),
            ),
          );
          const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const committedEvents: OrchestrationEvent[] = [];
                let nextCommandReadModel = commandReadModel;

                for (const nextEvent of eventBases) {
                  const savedEvent = yield* eventStore.append(nextEvent);
                  nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                  yield* projectionPipeline.projectEvent(savedEvent);
                  committedEvents.push(savedEvent);
                }

                const lastSavedEvent = committedEvents.at(-1) ?? null;
                if (lastSavedEvent === null) {
                  return yield* new OrchestrationCommandInvariantError({
                    commandType: envelope.command.type,
                    detail: "Command produced no events.",
                  });
                }

                yield* commandReceiptRepository.upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: lastSavedEvent.aggregateKind,
                  aggregateId: lastSavedEvent.aggregateId,
                  acceptedAt: lastSavedEvent.occurredAt,
                  resultSequence: lastSavedEvent.sequence,
                  status: "accepted",
                  error: null,
                });

                return {
                  committedEvents,
                  lastSequence: lastSavedEvent.sequence,
                  nextCommandReadModel,
                } as const;
              }),
            )
            .pipe(
              Effect.catchTag("SqlError", (sqlError) =>
                Effect.fail(
                  toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(
                    sqlError,
                  ),
                ),
              ),
            );
        });

        // An invariant failure is the only symptom a stale read model has, so
        // it is also the only place worth paying for a rehydrate. Retried once
        // and only when the projection actually moved, so a genuinely invalid
        // command still fails on the first pass with its original error.
        const committedCommand = yield* decideAndCommit.pipe(
          Effect.catch((error) => {
            if (!isOrchestrationCommandInvariantError(error)) {
              return Effect.fail(error);
            }
            return refreshCommandReadModelIfStale.pipe(
              Effect.catch((refreshError) =>
                Effect.logWarning("failed to refresh stale orchestration read model", {
                  commandId: envelope.command.commandId,
                  commandType: envelope.command.type,
                  cause: refreshError,
                }).pipe(Effect.as(false)),
              ),
              Effect.flatMap((refreshed) => {
                if (!refreshed) {
                  return Effect.fail(error);
                }
                // A warning, not an info line: reaching here means another
                // process wrote this database behind us. The boot-time sibling
                // check only fires in whichever backend started *second*, and
                // the one that suffers is usually the incumbent — this is the
                // only place the affected process says so, at the moment it
                // matters.
                return Effect.logWarning(
                  "orchestration read model was stale; another process is writing this state store. Refreshed from the projection and retried.",
                  {
                    commandId: envelope.command.commandId,
                    commandType: envelope.command.type,
                    aggregateId: aggregateRef.aggregateId,
                    detail: error.detail,
                    snapshotSequence: commandReadModel.snapshotSequence,
                  },
                ).pipe(Effect.flatMap(() => decideAndCommit));
              }),
            );
          }),
        );

        commandReadModel = committedCommand.nextCommandReadModel;
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - envelope.startedAtMs)),
            );
          }
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (!isOrchestrationCommandPreviouslyRejectedError(error)) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: commandReadModel.snapshotSequence,
                  }),
                ),
              ),
            );

            if (isOrchestrationCommandInvariantError(error)) {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: yield* nowIso,
                  resultSequence: commandReadModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(worker);
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive) =>
    eventStore.readFromSequence(fromSequenceExclusive);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, {
        command,
        result,
        startedAtMs: yield* Clock.currentTimeMillis,
      });
      return yield* Deferred.await(result);
    });

  return {
    readEvents,
    dispatch,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
