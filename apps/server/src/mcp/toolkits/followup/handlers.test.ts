import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerRuntimeStartup } from "../../../serverRuntimeStartup.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { FollowupToolkitHandlersLive } from "./handlers.ts";
import { FollowupToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment-followup-test");
const projectId = ProjectId.make("project-dealjourney");
const threadId = ThreadId.make("thread-email-templates");
const spinOffThreadId = ThreadId.make("thread-merge-fields");
const goneThreadId = ThreadId.make("thread-deleted");

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "followup-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-followup-test",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
};

const followupActivity = (input: {
  readonly activityId: string;
  readonly createdAt: string;
  readonly followup: Record<string, unknown>;
}): OrchestrationThreadActivity =>
  ({
    id: input.activityId,
    tone: "info",
    kind: "turn.followup.suggested",
    summary: String(input.followup.title),
    payload: { followup: input.followup },
    turnId: input.followup.turnId ?? null,
    createdAt: input.createdAt,
  }) as unknown as OrchestrationThreadActivity;

const activities: Array<OrchestrationThreadActivity> = [
  followupActivity({
    activityId: "activity-1",
    createdAt: "2026-08-05T08:26:57.000Z",
    followup: {
      id: "followup-1",
      turnId: "turn-1",
      title: "Merge fields don't resolve in workflow-sent templates",
      detail: "Renders as empty text.",
      rationale: null,
      status: "pending",
      implementationThreadId: null,
      createdAt: "2026-08-05T08:26:57.000Z",
      updatedAt: "2026-08-05T08:26:57.000Z",
    },
  }),
  followupActivity({
    activityId: "activity-2",
    createdAt: "2026-08-05T08:27:00.000Z",
    followup: {
      id: "followup-2",
      turnId: "turn-1",
      title: "Retire the orphaned /tasks route",
      detail: null,
      rationale: null,
      status: "pending",
      implementationThreadId: null,
      createdAt: "2026-08-05T08:27:00.000Z",
      updatedAt: "2026-08-05T08:27:00.000Z",
    },
  }),
  followupActivity({
    // Spun off into another conversation, so it is no longer a chip — but the
    // agent still has to be able to see where the work went.
    activityId: "activity-3",
    createdAt: "2026-08-05T08:40:00.000Z",
    followup: {
      id: "followup-3",
      turnId: "turn-1",
      title: "Rewrite the merge-field parser",
      detail: null,
      rationale: null,
      status: "spunOff",
      implementationThreadId: spinOffThreadId,
      createdAt: "2026-08-05T08:28:00.000Z",
      updatedAt: "2026-08-05T08:40:00.000Z",
    },
  }),
  followupActivity({
    // The conversation this one points at is gone; the link reads as null
    // rather than failing the listing.
    activityId: "activity-4",
    createdAt: "2026-08-05T08:41:00.000Z",
    followup: {
      id: "followup-4",
      turnId: "turn-1",
      title: "Chase the flaky snapshot test",
      detail: null,
      rationale: null,
      status: "spunOff",
      implementationThreadId: goneThreadId,
      createdAt: "2026-08-05T08:29:00.000Z",
      updatedAt: "2026-08-05T08:41:00.000Z",
    },
  }),
  followupActivity({
    // A later activity for followup-2 would win; this one is for a follow-up
    // that was already dismissed, and must not resurface as pending.
    activityId: "activity-5",
    createdAt: "2026-08-05T08:45:00.000Z",
    followup: {
      id: "followup-5",
      turnId: "turn-1",
      title: "Already handled",
      detail: null,
      rationale: null,
      status: "dismissed",
      implementationThreadId: null,
      createdAt: "2026-08-05T08:30:00.000Z",
      updatedAt: "2026-08-05T08:45:00.000Z",
    },
  }),
];

const spinOffThread = {
  id: spinOffThreadId,
  projectId,
  title: "Rewrite the merge-field parser",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "t3/merge-fields",
  worktreePath: "C:/worktrees/dealjourney/merge-fields",
  latestTurn: {
    turnId: "turn-9",
    state: "running",
    requestedAt: "2026-08-05T08:41:00.000Z",
    startedAt: "2026-08-05T08:41:00.000Z",
    completedAt: null,
    assistantMessageId: null,
  },
  createdAt: "2026-08-05T08:40:00.000Z",
  updatedAt: "2026-08-05T08:42:00.000Z",
  archivedAt: null,
  pinnedAt: null,
  doneAt: null,
  session: null,
  latestUserMessageAt: "2026-08-05T08:40:00.000Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasPendingFollowups: false,
  hasActionableProposedPlan: false,
} as unknown as OrchestrationThreadShell;

/**
 * The `suggest_followup` call behind followup-2, which put its body under
 * `description` instead of `detail` — so the recorded follow-up has no detail
 * of its own and the text only survives here.
 */
const followupToolCallActivities: Array<OrchestrationThreadActivity> = [
  {
    id: "activity-tool-1",
    tone: "tool",
    kind: "tool.completed",
    summary: "Suggest a follow-up",
    payload: {
      itemType: "mcp_tool_call",
      data: {
        toolName: "mcp__t3-code__suggest_followup",
        input: {
          title: "Retire the orphaned /tasks route",
          description: "Nothing links to it since the board landed.",
          why: "It is the last thing reading the legacy task table.",
        },
        result: { tool_use_id: "followup-2", type: "tool_result" },
      },
    },
    turnId: "turn-1",
    createdAt: "2026-08-05T08:27:00.000Z",
  } as unknown as OrchestrationThreadActivity,
];

const dispatched: OrchestrationCommand[] = [];
/** Kinds the handler asked the projection for, so the narrow read stays narrow. */
const requestedKinds: Array<ReadonlyArray<string>> = [];
/** How often the repair read fired, so it stays conditional. */
let followupToolCallReads = 0;

const TestServicesLive = Layer.mergeAll(
  Layer.succeed(
    ProjectionSnapshotQuery,
    ProjectionSnapshotQuery.of({
      listThreadActivitiesByKinds: (requestedThreadId: ThreadId, kinds: ReadonlyArray<string>) => {
        requestedKinds.push(kinds);
        return Effect.succeed(
          requestedThreadId === threadId
            ? activities.filter((activity) => kinds.includes(activity.kind))
            : [],
        );
      },
      listFollowupToolCallActivities: (requestedThreadId: ThreadId) => {
        followupToolCallReads += 1;
        return Effect.succeed(requestedThreadId === threadId ? followupToolCallActivities : []);
      },
      getThreadShellById: (requestedThreadId: ThreadId) =>
        Effect.succeed(
          requestedThreadId === spinOffThreadId ? Option.some(spinOffThread) : Option.none(),
        ),
    } as unknown as ProjectionSnapshotQuery["Service"]),
  ),
  Layer.succeed(
    OrchestrationEngineService,
    OrchestrationEngineService.of({
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
    } as unknown as OrchestrationEngineService["Service"]),
  ),
  Layer.succeed(
    ServerRuntimeStartup,
    ServerRuntimeStartup.of({
      enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) => effect,
    } as unknown as ServerRuntimeStartup["Service"]),
  ),
);

const TestLayer = McpServer.toolkit(FollowupToolkit).pipe(
  Layer.provide(FollowupToolkitHandlersLive),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(TestServicesLive),
  Layer.provideMerge(NodeServices.layer),
);

const callTool = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("lists this conversation's pending follow-ups by default, with totals for the rest", () =>
  Effect.scoped(
    Effect.gen(function* () {
      requestedKinds.length = 0;

      const result = yield* callTool("list_followups", {});
      expect(result.isError).toBe(false);
      const listed = result.structuredContent as {
        followups: ReadonlyArray<{ followupId: string; status: string }>;
        counts: Record<string, number>;
        truncated: boolean;
      };

      expect(listed.followups.map((followup) => followup.followupId)).toEqual([
        "followup-1",
        "followup-2",
      ]);
      // Counts cover every status regardless of the filter, so the agent can
      // say "2 pending, 2 already spun off" without a second call.
      expect(listed.counts).toEqual({ pending: 2, spunOff: 2, done: 0, dismissed: 1 });
      expect(listed.truncated).toBe(false);
      // Read through the kind-filtered query, not the whole thread detail.
      expect(requestedKinds).toEqual([["turn.followup.suggested"]]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("recovers a description the agent filed under the wrong field name", () =>
  Effect.scoped(
    Effect.gen(function* () {
      followupToolCallReads = 0;

      const result = yield* callTool("list_followups", {});
      const listed = result.structuredContent as {
        followups: ReadonlyArray<{
          followupId: string;
          detail: string | null;
          rationale: string | null;
        }>;
      };

      const repaired = listed.followups.find((followup) => followup.followupId === "followup-2");
      expect(repaired?.detail).toBe("Nothing links to it since the board landed.");
      expect(repaired?.rationale).toBe("It is the last thing reading the legacy task table.");
      // A follow-up that carried its own detail is left exactly as recorded.
      expect(
        listed.followups.find((followup) => followup.followupId === "followup-1")?.detail,
      ).toBe("Renders as empty text.");
      // One extra read, and only because something was actually missing.
      expect(followupToolCallReads).toBe(1);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reports the conversation a follow-up was spun off into, and its state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* callTool("list_followups", { status: ["spunOff"] });
      expect(result.isError).toBe(false);
      const listed = result.structuredContent as {
        followups: ReadonlyArray<{
          followupId: string;
          implementationThread: { threadId: string; title: string; state: string } | null;
        }>;
      };

      expect(listed.followups).toHaveLength(2);
      expect(listed.followups[0]?.implementationThread).toMatchObject({
        threadId: spinOffThreadId,
        title: "Rewrite the merge-field parser",
        state: "running",
      });
      // A conversation that has since been deleted reads as a null link rather
      // than failing the whole listing.
      expect(listed.followups[1]?.implementationThread).toBeNull();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("closes a follow-up without dropping the rest of its record", () =>
  Effect.scoped(
    Effect.gen(function* () {
      dispatched.length = 0;

      const result = yield* callTool("resolve_followup", {
        followupId: "followup-1",
        status: "done",
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        followupId: "followup-1",
        status: "done",
        // followup-2 is still on the deck.
        remainingPending: 1,
      });

      expect(dispatched).toHaveLength(1);
      const command = dispatched[0] as {
        type: string;
        commandId: string;
        threadId: string;
        followup: Record<string, unknown>;
      };
      expect(command.type).toBe("thread.followup.upsert");
      expect(command.commandId.startsWith("followup:")).toBe(true);
      // Scoped to the calling conversation: there is no thread id to pass, and
      // no way to reach another thread's chips from here.
      expect(command.threadId).toBe(threadId);
      // Only status and updatedAt may move: dropping turnId would detach the
      // follow-up from its turn in the timeline.
      expect(command.followup).toMatchObject({
        id: "followup-1",
        turnId: "turn-1",
        title: "Merge fields don't resolve in workflow-sent templates",
        detail: "Renders as empty text.",
        implementationThreadId: null,
        createdAt: "2026-08-05T08:26:57.000Z",
        status: "done",
      });
      expect(command.followup.updatedAt).not.toBe("2026-08-05T08:26:57.000Z");

      dispatched.length = 0;
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("is idempotent and names the real ids when given an unknown one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      dispatched.length = 0;

      // Already dismissed, so re-dismissing appends nothing.
      const repeat = yield* callTool("resolve_followup", {
        followupId: "followup-5",
        status: "dismissed",
      });
      expect(repeat.isError).toBe(false);
      expect(dispatched).toHaveLength(0);

      const unknown = yield* callTool("resolve_followup", {
        followupId: "followup-does-not-exist",
        status: "done",
      });
      expect(unknown.isError).toBe(true);
      const text = unknown.content.map((entry) => ("text" in entry ? entry.text : "")).join(" ");
      expect(text).toContain("followup-1");
      expect(dispatched).toHaveLength(0);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("still acknowledges suggest_followup, which the adapter records", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* callTool("suggest_followup", { title: "Something else" });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({ acknowledged: true });
    }),
  ).pipe(Effect.provide(TestLayer)),
);
