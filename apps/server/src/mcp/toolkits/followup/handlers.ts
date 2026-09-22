import { CommandId, type IsoDateTime, type OrchestrationFollowup } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerRuntimeStartup } from "../../../serverRuntimeStartup.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  deriveFollowupRecords,
  describeThreadState,
  FOLLOWUP_ACTIVITY_KINDS,
  needsFollowupDetailRepair,
  repairFollowupDetails,
} from "./records.ts";
import { FollowupToolError, FollowupToolkit } from "./tools.ts";

const DEFAULT_LIST_LIMIT = 50;

const snapshotError = (action: string) => (cause: unknown) =>
  new FollowupToolError({
    message: `Failed to ${action}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

/**
 * Every follow-up this conversation has, oldest first.
 *
 * Read through the kind-filtered activity query rather than the thread detail:
 * the detail row carries every message and every tool call, and this needs one
 * activity kind out of dozens.
 */
const readFollowups = Effect.fn("followup.readFollowups")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const activities = yield* projectionSnapshotQuery
    .listThreadActivitiesByKinds(invocation.threadId, FOLLOWUP_ACTIVITY_KINDS)
    .pipe(Effect.mapError(snapshotError("read this conversation's follow-ups")));
  const byId = deriveFollowupRecords(activities);
  // Follow-ups recorded before the adapter learned to read misnamed arguments
  // have no detail of their own; the call that made them still does. Only
  // fetched when something is actually missing, so a deck written since then
  // never pays for it.
  if (needsFollowupDetailRepair(byId)) {
    const toolCalls = yield* projectionSnapshotQuery
      .listFollowupToolCallActivities(invocation.threadId)
      .pipe(Effect.mapError(snapshotError("read this conversation's follow-ups")));
    repairFollowupDetails(byId, toolCalls);
  }
  const ordered = [...byId.values()].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  return { threadId: invocation.threadId, byId, ordered };
});

const countByStatus = (followups: ReadonlyArray<OrchestrationFollowup>) => ({
  pending: followups.filter((followup) => followup.status === "pending").length,
  spunOff: followups.filter((followup) => followup.status === "spunOff").length,
  done: followups.filter((followup) => followup.status === "done").length,
  dismissed: followups.filter((followup) => followup.status === "dismissed").length,
});

const handlers = {
  // The real work of recording a follow-up (surfacing it as a runtime event)
  // happens in the provider adapter's permission callback when it observes this
  // tool call. The handler only has to acknowledge so the agent sees a
  // successful result and continues without interruption.
  suggest_followup: () => Effect.succeed({ acknowledged: true }),

  list_followups: (input) =>
    Effect.gen(function* () {
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const { ordered } = yield* readFollowups();

      const wanted = new Set(input.status ?? ["pending"]);
      const matching = ordered.filter((followup) => wanted.has(followup.status));
      const limit = input.limit ?? DEFAULT_LIST_LIMIT;
      const page = matching.slice(0, limit);

      // Resolve the spun-off conversations in one pass, deduplicated: several
      // follow-ups can have been handed to the same thread.
      const implementationThreadIds = [
        ...new Set(
          page
            .map((followup) => followup.implementationThreadId)
            .filter((threadId): threadId is NonNullable<typeof threadId> => threadId !== null),
        ),
      ];
      const implementationThreads = new Map(
        yield* Effect.forEach(implementationThreadIds, (threadId) =>
          projectionSnapshotQuery.getThreadShellById(threadId).pipe(
            // A thread that has since been deleted or archived reads as absent;
            // that is a null link, not a failure of the whole listing.
            Effect.orElseSucceed(() => Option.none()),
            Effect.map(
              (shell) =>
                [
                  threadId,
                  Option.match(shell, {
                    onNone: () => null,
                    onSome: (thread) => ({
                      threadId: thread.id,
                      title: thread.title,
                      state: describeThreadState(thread),
                      updatedAt: thread.updatedAt,
                    }),
                  }),
                ] as const,
            ),
          ),
        ),
      );

      return {
        followups: page.map((followup) => ({
          followupId: followup.id,
          title: followup.title,
          detail: followup.detail,
          rationale: followup.rationale,
          status: followup.status,
          turnId: followup.turnId,
          implementationThread:
            followup.implementationThreadId === null
              ? null
              : (implementationThreads.get(followup.implementationThreadId) ?? null),
          createdAt: followup.createdAt,
          updatedAt: followup.updatedAt,
        })),
        counts: countByStatus(ordered),
        truncated: matching.length > page.length,
      };
    }),

  resolve_followup: (input) =>
    Effect.gen(function* () {
      const orchestrationEngine = yield* OrchestrationEngineService;
      const startup = yield* ServerRuntimeStartup;
      const crypto = yield* Crypto.Crypto;

      const { threadId, byId, ordered } = yield* readFollowups();
      const existing = byId.get(input.followupId);
      if (existing === undefined) {
        const pending = ordered
          .filter((followup) => followup.status === "pending")
          .map((followup) => `${followup.id} ("${followup.title}")`);
        return yield* new FollowupToolError({
          message:
            pending.length === 0
              ? `No follow-up with id ${input.followupId} in this conversation, and it has no pending follow-ups at all. Run list_followups rather than guessing an id.`
              : `No follow-up with id ${input.followupId} in this conversation. Its pending follow-ups are: ${pending.join(", ")}.`,
        });
      }

      // What the deck looks like once this one is closed. Both requestable
      // statuses are non-pending, so it is simply everything else still pending.
      const remainingPending = ordered.filter(
        (followup) => followup.id !== existing.id && followup.status === "pending",
      ).length;

      // Already in the requested state: report success without appending
      // another activity, so a retry does not grow the log.
      if (existing.status === input.status) {
        return {
          followupId: existing.id,
          title: existing.title,
          status: input.status,
          remainingPending,
        };
      }

      const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const commandUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);

      yield* startup
        .enqueueCommand(
          orchestrationEngine.dispatch({
            type: "thread.followup.upsert",
            commandId: CommandId.make(`followup:${commandUuid}`),
            threadId,
            // Everything but the status is carried through untouched: the
            // record is re-appended whole, and the latest one per id wins.
            followup: { ...existing, status: input.status, updatedAt: now as IsoDateTime },
            createdAt: now,
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new FollowupToolError({
                message: `Failed to close the follow-up: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
              }),
          ),
        );

      return {
        followupId: existing.id,
        title: existing.title,
        status: input.status,
        remainingPending,
      };
    }),
} satisfies Parameters<typeof FollowupToolkit.toLayer>[0];

export const FollowupToolkitHandlersLive = FollowupToolkit.toLayer(handlers);
