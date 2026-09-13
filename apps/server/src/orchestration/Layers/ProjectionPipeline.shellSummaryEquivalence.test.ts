import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  OrchestrationProposedPlanId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
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
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepository } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  deriveHasActionableProposedPlan,
  deriveThreadShellActivitySummary,
} from "../threadShellSummary.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

/**
 * The shell summary is now recomputed one part at a time, only for the parts an
 * event can move, and otherwise carried forward from the row. That is only
 * safe if carrying a part forward always lands on the same value a full
 * recompute would.
 *
 * So this drives one conversation through every event that touches the
 * summary - messages, questions asked and answered and gone stale, follow-ups
 * opened and closed, handoffs, approvals granted and gone stale, a proposed
 * plan across a turn, a revert - and after every single event compares the
 * stored summary against the original algorithm: load everything, derive
 * everything. Then it throws the projections away, replays the event log from
 * scratch, and checks the rebuilt summary is identical.
 */
const EquivalenceTestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-shell-summary-equivalence-" }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const PROJECT_ID = ProjectId.make("project-summary-equivalence");
const THREAD_ID = ThreadId.make("thread-summary-equivalence");
const TURN_ID = TurnId.make("turn-summary-equivalence-1");
const SECOND_TURN_ID = TurnId.make("turn-summary-equivalence-2");

/** A distinct, ordered timestamp per step, without reaching for the clock. */
const stamp = (step: number) =>
  `2026-03-02T09:${String(Math.floor(step / 60)).padStart(2, "0")}:${String(step % 60).padStart(2, "0")}.000Z`;

interface StoredSummary {
  readonly latestUserMessageAt: string | null;
  readonly pendingApprovalCount: number;
  readonly pendingUserInputCount: number;
  readonly pendingFollowupCount: number;
  readonly handoffThreadId: string | null;
  readonly sourceThreadId: string | null;
  readonly hasActionableProposedPlan: number;
}

it.layer(EquivalenceTestLayer)("thread shell summary equivalence", (it) => {
  it.effect(
    "matches a full recompute after every lifecycle event, and survives a replay from scratch",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const messages = yield* ProjectionThreadMessageRepository;
        const plans = yield* ProjectionThreadProposedPlanRepository;
        const activities = yield* ProjectionThreadActivityRepository;
        const approvals = yield* ProjectionPendingApprovalRepository;

        let step = 0;
        const ids = () => {
          step += 1;
          return {
            eventId: EventId.make(`evt-equivalence-${step}`),
            commandId: CommandId.make(`cmd-equivalence-${step}`),
            correlationId: CorrelationId.make(`cmd-equivalence-${step}`),
            occurredAt: stamp(step),
            causationEventId: null,
            metadata: {},
          };
        };

        const readStoredSummary = sql<StoredSummary>`
          SELECT
            latest_user_message_at AS "latestUserMessageAt",
            pending_approval_count AS "pendingApprovalCount",
            pending_user_input_count AS "pendingUserInputCount",
            pending_followup_count AS "pendingFollowupCount",
            handoff_thread_id AS "handoffThreadId",
            source_thread_id AS "sourceThreadId",
            has_actionable_proposed_plan AS "hasActionableProposedPlan"
          FROM projection_threads
          WHERE thread_id = ${THREAD_ID}
        `.pipe(
          Effect.flatMap((rows) => {
            const row = rows[0];
            // A missing row would make every comparison below vacuously equal.
            return row === undefined
              ? Effect.die(new Error("thread shell summary row is missing"))
              : Effect.succeed(row);
          }),
        );

        /** The algorithm this change replaced: read every row, derive every field. */
        const recomputeFromEverything = Effect.gen(function* () {
          const latestTurnRows = yield* sql<{ readonly latestTurnId: string | null }>`
            SELECT latest_turn_id AS "latestTurnId"
            FROM projection_threads
            WHERE thread_id = ${THREAD_ID}
          `;
          const allMessages = yield* messages.listByThreadId({ threadId: THREAD_ID });
          const allPlans = yield* plans.listByThreadId({ threadId: THREAD_ID });
          const allActivities = yield* activities.listByThreadId({ threadId: THREAD_ID });
          const allApprovals = yield* approvals.listByThreadId({ threadId: THREAD_ID });

          let latestUserMessageAt: string | null = null;
          for (const message of allMessages) {
            if (
              message.role === "user" &&
              (latestUserMessageAt === null || message.createdAt > latestUserMessageAt)
            ) {
              latestUserMessageAt = message.createdAt;
            }
          }
          const activitySummary = deriveThreadShellActivitySummary(allActivities);
          return {
            latestUserMessageAt,
            pendingApprovalCount: allApprovals.filter((approval) => approval.status === "pending")
              .length,
            pendingUserInputCount: activitySummary.pendingUserInputCount,
            pendingFollowupCount: activitySummary.pendingFollowupCount,
            handoffThreadId: activitySummary.handoffThreadId,
            sourceThreadId: activitySummary.sourceThreadId,
            hasActionableProposedPlan: deriveHasActionableProposedPlan({
              latestTurnId: latestTurnRows[0]?.latestTurnId ?? null,
              proposedPlans: allPlans,
            })
              ? 1
              : 0,
          } satisfies StoredSummary;
        });

        const seen = new Set<string>();
        const project = (label: string, event: Parameters<typeof eventStore.append>[0]) =>
          Effect.gen(function* () {
            const saved = yield* eventStore.append(event);
            yield* projectionPipeline.projectEvent(saved);
            const stored = yield* readStoredSummary;
            const expected = yield* recomputeFromEverything;
            assert.deepEqual(stored, expected, `summary diverged after: ${label}`);
            seen.add(
              [
                stored.latestUserMessageAt,
                stored.pendingApprovalCount,
                stored.pendingUserInputCount,
                stored.pendingFollowupCount,
                stored.handoffThreadId,
                stored.sourceThreadId,
                stored.hasActionableProposedPlan,
              ].join("|"),
            );
          });

        const activity = (
          label: string,
          kind: string,
          payload: unknown,
          turnId: TurnId | null = null,
        ) =>
          Effect.gen(function* () {
            const base = ids();
            yield* project(label, {
              type: "thread.activity-appended",
              ...base,
              aggregateKind: "thread",
              aggregateId: THREAD_ID,
              payload: {
                threadId: THREAD_ID,
                activity: {
                  id: EventId.make(`activity-${base.eventId}`),
                  tone: "info",
                  kind,
                  summary: label,
                  payload,
                  turnId,
                  createdAt: base.occurredAt,
                },
              },
            });
          });

        const message = (
          label: string,
          messageId: string,
          role: "user" | "assistant",
          streaming = false,
        ) =>
          Effect.gen(function* () {
            const base = ids();
            yield* project(label, {
              type: "thread.message-sent",
              ...base,
              aggregateKind: "thread",
              aggregateId: THREAD_ID,
              payload: {
                threadId: THREAD_ID,
                messageId: MessageId.make(messageId),
                role,
                text: label,
                turnId: null,
                streaming,
                createdAt: base.occurredAt,
                updatedAt: base.occurredAt,
              },
            });
          });

        const plan = (label: string, planId: string, turnId: TurnId | null, implemented: boolean) =>
          Effect.gen(function* () {
            const base = ids();
            yield* project(label, {
              type: "thread.proposed-plan-upserted",
              ...base,
              aggregateKind: "thread",
              aggregateId: THREAD_ID,
              payload: {
                threadId: THREAD_ID,
                proposedPlan: {
                  id: OrchestrationProposedPlanId.make(planId),
                  turnId,
                  planMarkdown: `Plan ${planId}`,
                  implementedAt: implemented ? base.occurredAt : null,
                  implementationThreadId: null,
                  createdAt: stamp(1),
                  updatedAt: base.occurredAt,
                },
              },
            });
          });

        const session = (label: string, activeTurnId: TurnId | null, status: "running" | "ready") =>
          Effect.gen(function* () {
            const base = ids();
            yield* project(label, {
              type: "thread.session-set",
              ...base,
              aggregateKind: "thread",
              aggregateId: THREAD_ID,
              payload: {
                threadId: THREAD_ID,
                session: {
                  threadId: THREAD_ID,
                  status,
                  providerName: "codex",
                  runtimeMode: "full-access",
                  activeTurnId,
                  lastError: null,
                  updatedAt: base.occurredAt,
                },
              },
            });
          });

        // Setup.
        const projectBase = ids();
        const savedProject = yield* eventStore.append({
          type: "project.created",
          ...projectBase,
          aggregateKind: "project",
          aggregateId: PROJECT_ID,
          payload: {
            projectId: PROJECT_ID,
            title: "Summary equivalence",
            workspaceRoot: "/tmp/summary-equivalence",
            defaultModelSelection: null,
            scripts: [],
            createdAt: projectBase.occurredAt,
            updatedAt: projectBase.occurredAt,
          },
        });
        yield* projectionPipeline.projectEvent(savedProject);
        const threadBase = ids();
        yield* project("thread created", {
          type: "thread.created",
          ...threadBase,
          aggregateKind: "thread",
          aggregateId: THREAD_ID,
          payload: {
            threadId: THREAD_ID,
            projectId: PROJECT_ID,
            title: "Every lifecycle event",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: threadBase.occurredAt,
            updatedAt: threadBase.occurredAt,
          },
        });

        // Messages, including a streamed assistant reply updated in place.
        yield* message("first user message", "message-user-1", "user");
        yield* message("assistant starts streaming", "message-assistant-1", "assistant", true);
        yield* message("assistant finishes", "message-assistant-1", "assistant", false);
        yield* activity("ordinary tool call", "tool.updated", { itemType: "command_execution" });

        // A question asked, answered, resolved; another that goes stale.
        yield* activity("question asked", "user-input.requested", { requestId: "question-1" });
        {
          const base = ids();
          yield* project("question answer requested", {
            type: "thread.user-input-response-requested",
            ...base,
            aggregateKind: "thread",
            aggregateId: THREAD_ID,
            payload: {
              threadId: THREAD_ID,
              requestId: ApprovalRequestId.make("question-1"),
              answers: { choice: "workspace-write" },
              createdAt: base.occurredAt,
            },
          });
        }
        yield* activity("question resolved", "user-input.resolved", { requestId: "question-1" });
        yield* activity("second question", "user-input.requested", { requestId: "question-2" });
        yield* activity("second question went stale", "provider.user-input.respond.failed", {
          requestId: "question-2",
          detail: "Unknown pending user input request: question-2",
        });

        // Follow-ups opened, one closed.
        yield* activity("follow-up one", "turn.followup.suggested", {
          followup: { id: "followup-1", status: "pending" },
        });
        yield* activity("follow-up two", "turn.followup.suggested", {
          followup: { id: "followup-2", status: "pending" },
        });
        yield* activity("follow-up one done", "turn.followup.suggested", {
          followup: { id: "followup-1", status: "done" },
        });

        // Handoffs in both directions.
        yield* activity("continued in another thread", "thread.handoff", {
          handoff: { counterpartThreadId: "thread-continued", direction: "continuedIn" },
        });
        yield* activity("spun off from another thread", "thread.handoff", {
          handoff: { counterpartThreadId: "thread-source", direction: "spunOffFrom" },
        });

        // Approvals: one granted, one gone stale.
        yield* activity("approval requested", "approval.requested", { requestId: "approval-1" });
        {
          const base = ids();
          yield* project("approval response requested", {
            type: "thread.approval-response-requested",
            ...base,
            aggregateKind: "thread",
            aggregateId: THREAD_ID,
            payload: {
              threadId: THREAD_ID,
              requestId: ApprovalRequestId.make("approval-1"),
              decision: "accept",
              createdAt: base.occurredAt,
            },
          });
        }
        yield* activity("approval resolved", "approval.resolved", {
          requestId: "approval-1",
          decision: "accept",
        });
        yield* activity("second approval", "approval.requested", { requestId: "approval-2" });
        yield* activity("second approval went stale", "provider.approval.respond.failed", {
          requestId: "approval-2",
          detail: "Unknown pending approval request: approval-2",
        });

        // A turn with a proposed plan, implemented, then superseded.
        yield* session("turn starts", TURN_ID, "running");
        yield* plan("plan proposed for the turn", "plan-1", TURN_ID, false);
        yield* activity("tool call inside the turn", "tool.completed", { ok: true }, TURN_ID);
        {
          const base = ids();
          yield* project("turn diff completed", {
            type: "thread.turn-diff-completed",
            ...base,
            aggregateKind: "thread",
            aggregateId: THREAD_ID,
            payload: {
              threadId: THREAD_ID,
              turnId: TURN_ID,
              checkpointTurnCount: 1,
              checkpointRef: CheckpointRef.make("refs/t3/checkpoints/summary-equivalence/turn/1"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: base.occurredAt,
            },
          });
        }
        yield* plan("plan implemented", "plan-1", TURN_ID, true);
        yield* session("session settles without moving the latest turn", null, "ready");
        yield* plan("an unattached plan appears", "plan-2", null, false);
        // The latest turn moves while plans already exist, with no plan event of
        // its own: the flag flips from turn 1's implemented plan to the newest
        // unimplemented one. Only the latest-turn rule can catch this.
        yield* session("a second turn starts", SECOND_TURN_ID, "running");
        yield* message("user comes back", "message-user-2", "user");

        // Revert rewrites messages, plans and activities at once.
        {
          const base = ids();
          yield* project("reverted to before the turn", {
            type: "thread.reverted",
            ...base,
            aggregateKind: "thread",
            aggregateId: THREAD_ID,
            payload: { threadId: THREAD_ID, turnCount: 0 },
          });
        }
        yield* activity("follow-up after the revert", "turn.followup.suggested", {
          followup: { id: "followup-3", status: "pending" },
        });

        // The sequence has to actually exercise the summary, not hold it still.
        assert.isAbove(seen.size, 8, "the scenario barely moved the summary");

        // Replay: discard every projection and rebuild from the event log.
        const beforeReplay = yield* readStoredSummary;
        for (const table of [
          "projection_threads",
          "projection_thread_messages",
          "projection_thread_proposed_plans",
          "projection_thread_activities",
          "projection_thread_sessions",
          "projection_turns",
          "projection_pending_approvals",
          "projection_projects",
          "projection_state",
        ]) {
          yield* sql.unsafe(`DELETE FROM ${table}`);
        }
        yield* projectionPipeline.bootstrap;
        const afterReplay = yield* readStoredSummary;
        assert.deepEqual(
          afterReplay,
          beforeReplay,
          "replaying the log produced a different summary",
        );
        assert.deepEqual(afterReplay, yield* recomputeFromEverything);
      }),
  );
});
