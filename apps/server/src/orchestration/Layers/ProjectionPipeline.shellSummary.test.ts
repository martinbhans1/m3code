import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

/**
 * The thread shell summary (pending counts, latest user message, follow-ups,
 * handoffs, actionable plan) used to be recomputed on every projected event by
 * reading and decoding the conversation's entire history. On a long
 * conversation that was over a hundred milliseconds per appended activity, and
 * it grew with every row.
 *
 * These tests pin the fix from the outside: they plant a history row whose
 * stored JSON cannot be decoded. Any path that still reads the whole activity
 * history trips over it and fails; a path that only reads what the event can
 * actually change never sees it.
 */
const ShellSummaryTestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-shell-summary-test-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const PROJECT_ID = ProjectId.make("project-shell-summary");
const THREAD_ID = ThreadId.make("thread-shell-summary");

let eventCounter = 0;
const nextIds = (label: string) => {
  eventCounter += 1;
  return {
    eventId: EventId.make(`evt-${label}-${eventCounter}`),
    commandId: CommandId.make(`cmd-${label}-${eventCounter}`),
    correlationId: CorrelationId.make(`cmd-${label}-${eventCounter}`),
  };
};

const at = (second: number) => `2026-03-01T10:00:${String(second).padStart(2, "0")}.000Z`;

it.layer(ShellSummaryTestLayer)("thread shell summary cost", (it) => {
  it.effect("does not read the conversation's history to project an ordinary activity", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        ...nextIds("project"),
        aggregateKind: "project",
        aggregateId: PROJECT_ID,
        occurredAt: at(0),
        causationEventId: null,
        metadata: {},
        payload: {
          projectId: PROJECT_ID,
          title: "Shell summary",
          workspaceRoot: "/tmp/shell-summary",
          defaultModelSelection: null,
          scripts: [],
          createdAt: at(0),
          updatedAt: at(0),
        },
      });
      yield* appendAndProject({
        type: "thread.created",
        ...nextIds("thread"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: at(1),
        causationEventId: null,
        metadata: {},
        payload: {
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Long conversation",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: at(1),
          updatedAt: at(1),
        },
      });

      // A row of old history that cannot be decoded. Reading it is the failure.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES (
          'activity-undecodable-history', ${THREAD_ID}, NULL, 'tool', 'tool.completed',
          'Old history', 'this is not json', NULL, ${at(2)}
        )
      `;

      const ordinary = yield* Effect.result(
        appendAndProject({
          type: "thread.activity-appended",
          ...nextIds("ordinary-activity"),
          aggregateKind: "thread",
          aggregateId: THREAD_ID,
          occurredAt: at(3),
          causationEventId: null,
          metadata: {},
          payload: {
            threadId: THREAD_ID,
            activity: {
              id: EventId.make("activity-ordinary-tool"),
              tone: "tool",
              kind: "tool.updated",
              summary: "Command run",
              payload: { itemType: "command_execution" },
              turnId: null,
              createdAt: at(3),
            },
          },
        }),
      );
      assert.equal(ordinary._tag, "Success", "an ordinary activity read the whole history");

      const rows = yield* sql<{ readonly updatedAt: string }>`
        SELECT updated_at AS "updatedAt" FROM projection_threads WHERE thread_id = ${THREAD_ID}
      `;
      assert.deepEqual(rows, [{ updatedAt: at(3) }]);
    }),
  );

  it.effect("reads only follow-up history when a follow-up changes, and still counts it", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      const result = yield* Effect.result(
        appendAndProject({
          type: "thread.activity-appended",
          ...nextIds("followup"),
          aggregateKind: "thread",
          aggregateId: THREAD_ID,
          occurredAt: at(4),
          causationEventId: null,
          metadata: {},
          payload: {
            threadId: THREAD_ID,
            activity: {
              id: EventId.make("activity-followup-1"),
              tone: "info",
              kind: "turn.followup.suggested",
              summary: "Suggested follow-up",
              payload: { followup: { id: "followup-1", status: "pending", title: "Next rung" } },
              turnId: null,
              createdAt: at(4),
            },
          },
        }),
      );
      assert.equal(result._tag, "Success", "a follow-up activity decoded unrelated history");

      const rows = yield* sql<{ readonly pendingFollowupCount: number }>`
        SELECT pending_followup_count AS "pendingFollowupCount"
        FROM projection_threads WHERE thread_id = ${THREAD_ID}
      `;
      assert.deepEqual(rows, [{ pendingFollowupCount: 1 }]);
    }),
  );

  it.effect("does not read activity history to project a user message", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      const result = yield* Effect.result(
        appendAndProject({
          type: "thread.message-sent",
          ...nextIds("user-message"),
          aggregateKind: "thread",
          aggregateId: THREAD_ID,
          occurredAt: at(5),
          causationEventId: null,
          metadata: {},
          payload: {
            threadId: THREAD_ID,
            messageId: MessageId.make("message-user-1"),
            role: "user",
            text: "carry on",
            turnId: null,
            streaming: false,
            createdAt: at(5),
            updatedAt: at(5),
          },
        }),
      );
      assert.equal(result._tag, "Success", "a user message read the activity history");

      const rows = yield* sql<{ readonly latestUserMessageAt: string | null }>`
        SELECT latest_user_message_at AS "latestUserMessageAt"
        FROM projection_threads WHERE thread_id = ${THREAD_ID}
      `;
      assert.deepEqual(rows, [{ latestUserMessageAt: at(5) }]);
    }),
  );
});
