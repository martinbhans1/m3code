import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type OrchestratorAccessOverride,
  type OrchestratorThreadAccess,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { CheckpointDiffQuery } from "../../../checkpointing/Services/CheckpointDiffQuery.ts";
import { ConversationSearch } from "../../../conversationSearch/ConversationSearch.ts";
import { GitWorkflowService } from "../../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSetupScriptRunner } from "../../../project/Services/ProjectSetupScriptRunner.ts";
import { ServerRuntimeStartup } from "../../../serverRuntimeStartup.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestratorToolkitHandlersLive } from "./handlers.ts";
import { OrchestratorToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment-orchestrator-test");
const metaProjectId = ProjectId.make("project-meta");
const workProjectId = ProjectId.make("project-dealjourney");
const metaThreadId = ThreadId.make("thread-meta");
const idleThreadId = ThreadId.make("thread-email-templates");
const busyThreadId = ThreadId.make("thread-busy");
const blockedThreadId = ThreadId.make("thread-blocked");
const questionThreadId = ThreadId.make("thread-question");
const interruptedThreadId = ThreadId.make("thread-interrupted");
const archivedThreadId = ThreadId.make("thread-archived");
const siblingMetaThreadId = ThreadId.make("thread-meta-sibling");

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "orchestrator-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const orchestratorInvocation: McpInvocationContext.McpInvocationScope = {
  environmentId,
  threadId: metaThreadId,
  providerSessionId: "provider-session-orchestrator-test",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities: new Set(["preview", "orchestrator"] as const),
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
};

const ordinaryInvocation: McpInvocationContext.McpInvocationScope = {
  ...orchestratorInvocation,
  threadId: idleThreadId,
  capabilities: new Set(["preview"] as const),
};

const makeShell = (
  overrides: Partial<OrchestrationThreadShell> & Pick<OrchestrationThreadShell, "id" | "title">,
): OrchestrationThreadShell =>
  ({
    projectId: workProjectId,
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "staging",
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-05T07:00:00.000Z",
    updatedAt: "2026-08-05T09:04:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    session: null,
    latestUserMessageAt: "2026-08-05T09:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasPendingFollowups: false,
    hasActionableProposedPlan: false,
    ...overrides,
  }) as OrchestrationThreadShell;

const idleThread = makeShell({
  id: idleThreadId,
  title: "Email template UX and fields",
  hasPendingFollowups: true,
  latestTurn: {
    turnId: "turn-1",
    state: "completed",
    requestedAt: "2026-08-05T07:25:00.000Z",
    startedAt: "2026-08-05T07:25:00.000Z",
    completedAt: "2026-08-05T09:04:00.000Z",
    assistantMessageId: "message-2",
  },
} as unknown as Partial<OrchestrationThreadShell> & Pick<OrchestrationThreadShell, "id" | "title">);

const busyThread = makeShell({
  id: busyThreadId,
  title: "Telavox dial failure regression",
  updatedAt: "2026-08-05T09:10:00.000Z",
  latestTurn: {
    turnId: "turn-2",
    state: "running",
    requestedAt: "2026-08-05T09:10:00.000Z",
    startedAt: "2026-08-05T09:10:00.000Z",
    completedAt: null,
    assistantMessageId: null,
  },
} as unknown as Partial<OrchestrationThreadShell> & Pick<OrchestrationThreadShell, "id" | "title">);

const metaThread = makeShell({
  id: metaThreadId,
  title: "Mission control",
  projectId: metaProjectId,
  updatedAt: "2026-08-05T09:20:00.000Z",
});

const siblingMetaThread = makeShell({
  id: siblingMetaThreadId,
  title: "Mission control (second)",
  projectId: metaProjectId,
  updatedAt: "2026-08-05T09:19:00.000Z",
});

const blockedThread = makeShell({
  id: blockedThreadId,
  title: "Archive Status Sync Review",
  updatedAt: "2026-08-05T09:12:00.000Z",
  hasPendingApprovals: true,
});

const questionThread = makeShell({
  id: questionThreadId,
  title: "Pipeline and win-rate metrics",
  updatedAt: "2026-08-05T09:14:00.000Z",
  hasPendingUserInput: true,
});

const interruptedThread = makeShell({
  id: interruptedThreadId,
  title: "Video lab loading failure",
  updatedAt: "2026-08-05T09:08:00.000Z",
  latestTurn: {
    turnId: "turn-3",
    state: "interrupted",
    requestedAt: "2026-08-05T09:05:00.000Z",
    startedAt: "2026-08-05T09:05:00.000Z",
    completedAt: "2026-08-05T09:08:00.000Z",
    assistantMessageId: null,
  },
} as unknown as Partial<OrchestrationThreadShell> & Pick<OrchestrationThreadShell, "id" | "title">);

const archivedThread = makeShell({
  id: archivedThreadId,
  title: "Retire saved reports blob path",
  updatedAt: "2026-08-04T09:47:00.000Z",
  archivedAt: "2026-08-04T10:00:00.000Z",
});

const projects: ReadonlyArray<OrchestrationProjectShell> = [
  {
    id: workProjectId,
    title: "dealjourney",
    workspaceRoot: "C:/repos/dealjourney",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-08-05T09:04:00.000Z",
  },
  {
    id: metaProjectId,
    title: "mission-control",
    workspaceRoot: "C:/repos/mission-control",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-08-05T09:20:00.000Z",
  },
] as unknown as ReadonlyArray<OrchestrationProjectShell>;

const threadDetail = {
  ...idleThread,
  messages: [
    {
      id: "message-1",
      role: "user",
      text: "Make the merge fields nicer",
      turnId: "turn-1",
      streaming: false,
      createdAt: "2026-08-05T07:25:00.000Z",
      updatedAt: "2026-08-05T07:25:00.000Z",
    },
    {
      id: "message-2",
      role: "assistant",
      text: "x".repeat(4_000),
      turnId: "turn-1",
      streaming: false,
      createdAt: "2026-08-05T09:04:00.000Z",
      updatedAt: "2026-08-05T09:04:00.000Z",
    },
  ],
  proposedPlans: [],
  activities: [
    {
      id: "activity-1",
      tone: "info",
      kind: "turn.followup.suggested",
      summary: "Merge fields don't resolve in workflow-sent templates",
      payload: {
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
      },
      turnId: "turn-1",
      createdAt: "2026-08-05T08:26:57.000Z",
    },
    {
      // A follow-up that was later dismissed must not resurface: the latest
      // activity per id wins.
      id: "activity-2",
      tone: "info",
      kind: "turn.followup.suggested",
      summary: "Already handled",
      payload: {
        followup: {
          id: "followup-2",
          turnId: "turn-1",
          title: "Already handled",
          detail: null,
          rationale: null,
          status: "dismissed",
          implementationThreadId: null,
          createdAt: "2026-08-05T08:27:00.000Z",
          updatedAt: "2026-08-05T08:30:00.000Z",
        },
      },
      turnId: "turn-1",
      createdAt: "2026-08-05T08:30:00.000Z",
    },
  ],
  checkpoints: [
    {
      turnId: "turn-1",
      checkpointTurnCount: 1,
      checkpointRef: "refs/t3/checkpoints/x/turn/1",
      status: "ready",
      files: [
        { path: "src/templates.ts", kind: "modified", additions: 40, deletions: 5 },
        { path: "src/mail.ts", kind: "modified", additions: 2, deletions: 1 },
      ],
      assistantMessageId: "message-2",
      completedAt: "2026-08-05T09:04:00.000Z",
    },
    {
      turnId: "turn-2",
      checkpointTurnCount: 2,
      checkpointRef: "refs/t3/checkpoints/x/turn/2",
      status: "ready",
      files: [{ path: "src/templates.ts", kind: "modified", additions: 3, deletions: 0 }],
      assistantMessageId: null,
      completedAt: "2026-08-05T09:20:00.000Z",
    },
    {
      // A failed capture has no trustworthy numbers and must not be counted.
      turnId: "turn-3",
      checkpointTurnCount: 3,
      checkpointRef: "refs/t3/checkpoints/x/turn/3",
      status: "error",
      files: [{ path: "src/never-counted.ts", kind: "modified", additions: 999, deletions: 999 }],
      assistantMessageId: null,
      completedAt: "2026-08-05T09:30:00.000Z",
    },
  ],
} as unknown as OrchestrationThread;

const blastRadiusQuestion = {
  // The id is the question text: the SDK looks answers up by it.
  id: "Fixing pipeline + win-rate means changing `_build_summary_block`. How far should the fix reach?",
  header: "Blast radius",
  question:
    "Fixing pipeline + win-rate means changing `_build_summary_block`. How far should the fix reach?",
  multiSelect: false,
  options: [
    { label: "Fix the shared metrics", description: "The web Reports page gets the same fix." },
    // Empty description on purpose: the Claude adapter forwards option
    // descriptions unsanitized, so a model that omits one writes "". The UI
    // renders that fine, and this must not make the whole question invisible.
    { label: "Email-only", description: "" },
  ],
};

const questionThreadDetail = {
  ...questionThread,
  messages: [],
  proposedPlans: [],
  activities: [
    {
      // Already answered, so it must not show up as pending.
      id: "activity-q0",
      tone: "approval",
      kind: "user-input.requested",
      summary: "Question",
      payload: {
        requestId: "request-answered",
        questions: [
          {
            id: "Which report first?",
            header: "Order",
            question: "Which report first?",
            options: [{ label: "Pipeline", description: "Start there." }],
          },
        ],
      },
      turnId: "turn-9",
      createdAt: "2026-08-05T09:11:00.000Z",
    },
    {
      id: "activity-q1",
      tone: "approval",
      kind: "user-input.resolved",
      summary: "Answered",
      payload: { requestId: "request-answered", answers: { "Which report first?": "Pipeline" } },
      turnId: "turn-9",
      createdAt: "2026-08-05T09:12:00.000Z",
    },
    {
      id: "activity-q2",
      tone: "approval",
      kind: "user-input.requested",
      summary: "Question",
      payload: {
        requestId: "request-open",
        questions: [blastRadiusQuestion],
      },
      turnId: "turn-9",
      createdAt: "2026-08-05T09:14:00.000Z",
    },
    {
      // A provider that has forgotten the request retires it without ever
      // writing a resolved activity, so this must not stay on offer either.
      id: "activity-q3",
      tone: "error",
      kind: "user-input.requested",
      summary: "Question",
      payload: {
        requestId: "request-forgotten",
        questions: [
          {
            id: "Rerun the failed report?",
            header: "Retry",
            question: "Rerun the failed report?",
            options: [{ label: "Yes", description: "Run it again." }],
          },
        ],
      },
      turnId: "turn-9",
      createdAt: "2026-08-05T09:15:00.000Z",
    },
    {
      id: "activity-q4",
      tone: "error",
      kind: "provider.user-input.respond.failed",
      summary: "Respond failed",
      payload: {
        requestId: "request-forgotten",
        detail: "Unknown pending Codex user input request",
      },
      turnId: "turn-9",
      createdAt: "2026-08-05T09:16:00.000Z",
    },
  ],
  checkpoints: [],
} as unknown as OrchestrationThread;

const shellsById = new Map<string, OrchestrationThreadShell>([
  [idleThreadId, idleThread],
  [questionThreadId, questionThread],
  [busyThreadId, busyThread],
  [metaThreadId, metaThread],
  [siblingMetaThreadId, siblingMetaThread],
  [blockedThreadId, blockedThread],
  [interruptedThreadId, interruptedThread],
  // Archived threads are absent from the active shell lookups, exactly as the
  // real query filters them.
]);

const dispatched: OrchestrationCommand[] = [];
/** Every input the toolkit handed to conversation search, for passthrough assertions. */
const searched: Array<Record<string, unknown>> = [];
// Worktree preparation stubs, mutable so a test can make git fail the way a
// dirty or non-git project would.
let gitLocalStatus: { isRepo: boolean; refName: string | null } = {
  isRepo: true,
  refName: "staging",
};
let worktreeFailure: string | null = null;
// Tagged rather than a bare Error: untagged failures merge together in the
// Effect failure channel, and the handler reads `.message` off whatever it gets.
class StubGitError extends Data.TaggedError("StubGitError")<{ readonly message: string }> {}
let setupScriptStatus = "started";
// Mutable so a test can withdraw the designation mid-session, the way the
// settings toggle does.
let designatedProjectId: ProjectId | null = metaProjectId;
// Per-thread sharing, mutable so tests can revoke it. Threads absent here fall
// back to `defaultAccess` below.
let threadAccess: Record<string, OrchestratorThreadAccess> = {};
// The baseline every thread without an entry inherits. Mutable so a test can
// flip the whole app from opt-in to opt-out the way the settings row does.
let defaultAccess: OrchestratorThreadAccess = "none";
// The blanket override, set from the orchestrator's own composer. Mutable so a
// test can hand over everything mid-session the way the control does.
let accessOverride: OrchestratorAccessOverride = "per-conversation";
const resetAccess = () => {
  gitLocalStatus = { isRepo: true, refName: "staging" };
  worktreeFailure = null;
  setupScriptStatus = "started";
  defaultAccess = "none";
  accessOverride = "per-conversation";
  threadAccess = {
    [metaThreadId]: "control",
    [siblingMetaThreadId]: "control",
    [idleThreadId]: "control",
    [busyThreadId]: "control",
    [blockedThreadId]: "control",
    [questionThreadId]: "control",
    [interruptedThreadId]: "control",
    [archivedThreadId]: "control",
  };
};
resetAccess();

const TestServicesLive = Layer.mergeAll(
  Layer.succeed(
    ProjectionSnapshotQuery,
    ProjectionSnapshotQuery.of({
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects,
          threads: [
            idleThread,
            busyThread,
            metaThread,
            siblingMetaThread,
            blockedThread,
            questionThread,
            interruptedThread,
          ],
          updatedAt: "2026-08-05T09:20:00.000Z",
        }),
      getArchivedShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects,
          threads: [archivedThread],
          updatedAt: "2026-08-05T09:20:00.000Z",
        }),
      getThreadShellById: (threadId: ThreadId) =>
        Effect.succeed(Option.fromNullishOr(shellsById.get(threadId))),
      getThreadDetailById: (threadId: ThreadId) =>
        Effect.succeed(
          threadId === idleThreadId
            ? Option.some(threadDetail)
            : threadId === questionThreadId
              ? Option.some(questionThreadDetail)
              : Option.none(),
        ),
      // Mirrors the real narrow query: the capture history alone, without the
      // messages and activity payloads the detail row would drag along.
      getThreadCheckpointContext: (threadId: ThreadId) => {
        const detail =
          threadId === idleThreadId
            ? threadDetail
            : threadId === questionThreadId
              ? questionThreadDetail
              : null;
        return Effect.succeed(
          detail === null
            ? Option.none()
            : Option.some({
                threadId,
                projectId: detail.projectId,
                workspaceRoot: "/tmp/dealjourney",
                worktreePath: detail.worktreePath ?? null,
                checkpoints: detail.checkpoints ?? [],
              }),
        );
      },
      // Mirrors the real narrow query: newest `limit` messages, handed back in
      // reading order.
      getThreadMessagesTail: (threadId: ThreadId, limit: number) => {
        const detail =
          threadId === idleThreadId
            ? threadDetail
            : threadId === questionThreadId
              ? questionThreadDetail
              : null;
        const ordered = (detail?.messages ?? [])
          .toSorted((left: { createdAt: string }, right: { createdAt: string }) =>
            left.createdAt.localeCompare(right.createdAt),
          )
          .slice(-limit);
        return Effect.succeed(ordered);
      },
      // Mirrors the real narrow query: same rows the detail carries, filtered
      // to the requested kinds. Returning everything here would let a handler
      // that forgot to ask for a kind still pass.
      listThreadActivitiesByKinds: (threadId: ThreadId, kinds: ReadonlyArray<string>) => {
        const detail =
          threadId === idleThreadId
            ? threadDetail
            : threadId === questionThreadId
              ? questionThreadDetail
              : null;
        return Effect.succeed(
          (detail?.activities ?? []).filter((activity: { kind: string }) =>
            kinds.includes(activity.kind),
          ),
        );
      },
      getProjectShellById: (projectId: ProjectId) =>
        Effect.succeed(Option.fromNullishOr(projects.find((project) => project.id === projectId))),
    } as unknown as ProjectionSnapshotQuery["Service"]),
  ),
  Layer.succeed(
    ConversationSearch,
    ConversationSearch.of({
      search: (input: Record<string, unknown>) =>
        Effect.sync(() => {
          searched.push(input);
          return {
            results: [
              {
                threadId: idleThreadId,
                projectId: workProjectId,
                title: "Email template UX and fields",
                projectTitle: "dealjourney",
                branch: "staging",
                archivedAt: null,
                updatedAt: "2026-08-05T09:04:00.000Z",
                snippet: "merge fields",
                matchedRole: "assistant",
                matchKind: "hybrid",
                score: 0.8,
              },
            ],
            semanticStatus: "ready",
          };
        }),
    } as unknown as ConversationSearch["Service"]),
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
    ServerSettingsService,
    ServerSettingsService.of({
      getSettings: Effect.sync(() => ({
        ...DEFAULT_SERVER_SETTINGS,
        orchestratorProjectId: designatedProjectId,
        defaultOrchestratorThreadAccess: defaultAccess,
        orchestratorThreadAccess: threadAccess,
        orchestratorAccessOverride: accessOverride,
      })),
      updateSettings: (patch: {
        orchestratorThreadAccess?: Record<string, OrchestratorThreadAccess>;
        orchestratorThreadAccessEntry?: {
          threadId: string;
          access: OrchestratorThreadAccess | null;
        };
      }) =>
        // Mirrors `applyServerSettingsPatch`: whole-map first, then the
        // single-entry form, with a null access meaning "delete the key".
        Effect.sync(() => {
          if (patch.orchestratorThreadAccess) {
            threadAccess = { ...patch.orchestratorThreadAccess };
          }
          if (patch.orchestratorThreadAccessEntry) {
            const { threadId, access } = patch.orchestratorThreadAccessEntry;
            const next = { ...threadAccess };
            if (access === null) {
              delete next[threadId];
            } else {
              next[threadId] = access;
            }
            threadAccess = next;
          }
          return {
            ...DEFAULT_SERVER_SETTINGS,
            orchestratorProjectId: designatedProjectId,
            defaultOrchestratorThreadAccess: defaultAccess,
            orchestratorThreadAccess: threadAccess,
            orchestratorAccessOverride: accessOverride,
          };
        }),
    } as unknown as ServerSettingsService["Service"]),
  ),
  Layer.succeed(
    ServerRuntimeStartup,
    ServerRuntimeStartup.of({
      enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) => effect,
    } as unknown as ServerRuntimeStartup["Service"]),
  ),
  Layer.succeed(
    GitWorkflowService,
    GitWorkflowService.of({
      localStatus: () =>
        gitLocalStatus.isRepo
          ? Effect.succeed(gitLocalStatus)
          : Effect.succeed({ isRepo: false, refName: null }),
      createWorktree: (createInput: { newRefName?: string }) =>
        worktreeFailure === null
          ? Effect.succeed({
              worktree: {
                path: `C:/worktrees/dealjourney/${createInput.newRefName ?? "unnamed"}`,
                refName: createInput.newRefName ?? "unnamed",
              },
            })
          : Effect.fail(new StubGitError({ message: worktreeFailure })),
    } as unknown as GitWorkflowService["Service"]),
  ),
  Layer.succeed(
    ProjectSetupScriptRunner,
    ProjectSetupScriptRunner.of({
      runForThread: () => Effect.succeed({ status: setupScriptStatus }),
    } as unknown as ProjectSetupScriptRunner["Service"]),
  ),
  Layer.succeed(
    CheckpointDiffQuery,
    CheckpointDiffQuery.of({
      getTurnDiff: (request: { fromTurnCount: number; toTurnCount: number }) =>
        Effect.succeed({
          threadId: idleThreadId,
          fromTurnCount: request.fromTurnCount,
          toTurnCount: request.toTurnCount,
          diff: `--- a/src/templates.ts
+++ b/src/templates.ts
@@
+turn ${request.toTurnCount}`,
        }),
      getFullThreadDiff: (request: { toTurnCount: number }) =>
        Effect.succeed({
          threadId: idleThreadId,
          fromTurnCount: 0,
          toTurnCount: request.toTurnCount,
          diff: [
            "--- a/src/templates.ts",
            "+++ b/src/templates.ts",
            "@@",
            "+full thread diff",
          ].join("\n"),
        }),
    } as unknown as CheckpointDiffQuery["Service"]),
  ),
);

const TestLayer = McpServer.toolkit(OrchestratorToolkit).pipe(
  Layer.provide(OrchestratorToolkitHandlersLive),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(TestServicesLive),
  Layer.provideMerge(NodeServices.layer),
);

const callTool = (
  name: string,
  args: Record<string, unknown>,
  invocation: McpInvocationContext.McpInvocationScope = orchestratorInvocation,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("refuses every cross-thread tool without the orchestrator capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const [name, args] of [
        ["list_threads", {}],
        ["search_threads", { query: "email templates" }],
        ["read_thread", { threadId: idleThreadId }],
        ["list_pending", {}],
        ["send_to_thread", { threadId: idleThreadId, message: "hello" }],
      ] as const) {
        const result = yield* callTool(name, args, ordinaryInvocation);
        expect(result.isError, `${name} must reject an uncapable thread`).toBe(true);
      }
      expect(dispatched).toHaveLength(0);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("lists threads with derived phases and filters to those needing attention", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const all = yield* callTool("list_threads", {});
      expect(all.isError).toBe(false);
      const threads = (all.structuredContent as { threads: ReadonlyArray<Record<string, unknown>> })
        .threads;
      // Most recently updated first. The orchestrator project's own threads are
      // absent even though the fixture shares them: an orchestrator listing its
      // own past conversations is never useful.
      expect(threads.map((thread) => thread.threadId)).toEqual([
        questionThreadId,
        blockedThreadId,
        busyThreadId,
        interruptedThreadId,
        idleThreadId,
      ]);
      expect(threads.find((thread) => thread.threadId === busyThreadId)).toMatchObject({
        phase: "running",
        hasActiveTurn: true,
      });
      expect(threads.find((thread) => thread.threadId === idleThreadId)).toMatchObject({
        phase: "completed",
        hasActiveTurn: false,
        projectTitle: "dealjourney",
      });
      // A thread that has never run a turn has no awareness phase.
      expect(threads.find((thread) => thread.threadId === interruptedThreadId)).toMatchObject({
        phase: "interrupted",
      });

      const filtered = yield* callTool("list_threads", {
        projectTitle: "DEALJOURNEY",
        onlyNeedingAttention: true,
      });
      const attention = (
        filtered.structuredContent as { threads: ReadonlyArray<Record<string, unknown>> }
      ).threads;
      expect(attention.map((thread) => thread.threadId)).toEqual([
        questionThreadId,
        blockedThreadId,
        interruptedThreadId,
        idleThreadId,
      ]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reads a thread's tail, truncating long messages and surfacing open follow-ups", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* callTool("read_thread", { threadId: idleThreadId });
      expect(result.isError).toBe(false);
      const payload = result.structuredContent as {
        messages: ReadonlyArray<{ text: string; truncated: boolean }>;
        pendingFollowups: ReadonlyArray<{ followupId: string }>;
      };
      expect(payload.messages).toHaveLength(2);
      expect(payload.messages[1]?.truncated).toBe(true);
      expect(payload.messages[1]?.text.length).toBeLessThan(1_100);
      expect(payload.messages[0]?.truncated).toBe(false);
      // followup-2 was dismissed, so only the pending one comes back.
      expect(payload.pendingFollowups.map((followup) => followup.followupId)).toEqual([
        "followup-1",
      ]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reports a missing thread instead of failing opaquely", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* callTool("read_thread", { threadId: ThreadId.make("thread-gone") });
      expect(result.isError).toBe(true);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("dispatches a turn into an idle thread, inheriting its configuration", () =>
  Effect.scoped(
    Effect.gen(function* () {
      dispatched.length = 0;
      const result = yield* callTool("send_to_thread", {
        threadId: idleThreadId,
        message: "  The preview panel branding is off — use the shared tokens.  ",
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        threadId: idleThreadId,
        threadTitle: "Email template UX and fields",
        projectTitle: "dealjourney",
        steeredRunningTurn: false,
      });

      expect(dispatched).toHaveLength(1);
      const command = dispatched[0] as Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
      expect(command.type).toBe("thread.turn.start");
      expect(command.threadId).toBe(idleThreadId);
      expect(command.message.role).toBe("user");
      expect(command.message.text).toBe(
        "The preview panel branding is off — use the shared tokens.",
      );
      expect(command.message.attachments).toEqual([]);
      // The target thread's own settings, not the orchestrator's.
      expect(command.runtimeMode).toBe("full-access");
      expect(command.interactionMode).toBe("default");
      expect(command.modelSelection?.model).toBe("claude-opus-5");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses to send into a running thread unless steering is explicit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      dispatched.length = 0;
      const blocked = yield* callTool("send_to_thread", {
        threadId: busyThreadId,
        message: "also fix the header",
      });
      expect(blocked.isError).toBe(true);
      expect(dispatched).toHaveLength(0);

      const steered = yield* callTool("send_to_thread", {
        threadId: busyThreadId,
        message: "also fix the header",
        steerRunningTurn: true,
      });
      expect(steered.isError).toBe(false);
      expect(steered.structuredContent).toMatchObject({ steeredRunningTurn: true });
      expect(dispatched).toHaveLength(1);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses to send to itself or to send an empty message", () =>
  Effect.scoped(
    Effect.gen(function* () {
      dispatched.length = 0;
      const toSelf = yield* callTool("send_to_thread", {
        threadId: metaThreadId,
        message: "loop forever",
      });
      expect(toSelf.isError).toBe(true);

      const empty = yield* callTool("send_to_thread", {
        threadId: idleThreadId,
        message: "   ",
      });
      expect(empty.isError).toBe(true);
      expect(dispatched).toHaveLength(0);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("passes search through and reports semantic index status", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* callTool("search_threads", { query: "email template merge fields" });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        semanticStatus: "ready",
        results: [{ threadId: idleThreadId, snippet: "merge fields", archived: false }],
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("hands back a long message in full when asked, within a total budget", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // The fixture's assistant message is 4000 characters.
      const clipped = yield* callTool("read_thread", { threadId: idleThreadId });
      const clippedMessages = (
        clipped.structuredContent as {
          messages: ReadonlyArray<{ text: string; truncated: boolean }>;
        }
      ).messages;
      const clippedLong = clippedMessages.find((message) => message.truncated);
      expect(clippedLong?.text).toHaveLength(1_001);

      // Raising the budget returns the rest, so a decision written out in one
      // long message stops being unreadable from here.
      const full = yield* callTool("read_thread", {
        threadId: idleThreadId,
        messageChars: 5_000,
      });
      const fullMessages = (
        full.structuredContent as {
          messages: ReadonlyArray<{ text: string; truncated: boolean; createdAt: string }>;
        }
      ).messages;
      const restored = fullMessages.find((message) => message.text.length > 1_001);
      expect(restored?.text).toHaveLength(4_000);
      expect(restored?.truncated).toBe(false);

      // Still oldest-first, so raising the budget does not reorder the reading.
      const timestamps = fullMessages.map((message) => message.createdAt);
      expect(timestamps).toEqual(timestamps.toSorted());
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("says whose changes it is actually reporting", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* callTool("read_thread_changes", { threadId: idleThreadId });
      expect(result.isError).toBe(false);
      const payload = result.structuredContent as {
        sharedCheckout: boolean;
        otherThreadsInCheckout: number;
        attribution: string;
      };
      // The fixture thread has no worktree, so it shares the project checkout
      // with the other fixture threads — which is exactly the case where the
      // churn numbers are not this conversation's work.
      expect(payload.sharedCheckout).toBe(true);
      expect(payload.otherThreadsInCheckout).toBeGreaterThan(0);
      expect(payload.attribution).toContain("Not attributable to this conversation");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("forwards the literal-search request rather than quietly ranking it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      searched.length = 0;

      // Keyword search is the default: nothing is asked for, nothing is sent.
      yield* callTool("search_threads", { query: "email templates" });
      expect(searched.at(-1)?.exact).toBeUndefined();

      // A grep-shaped query has to reach the search layer as one, or it comes
      // back tokenized — and a path query that matches nothing would answer
      // with every thread mentioning "server" or "src".
      yield* callTool("search_threads", {
        query: "apps/server/src/mcp/toolkits/orchestrator/handlers.ts",
        exact: true,
      });
      expect(searched.at(-1)).toMatchObject({
        query: "apps/server/src/mcp/toolkits/orchestrator/handlers.ts",
        exact: true,
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("collects what is waiting on the user across threads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* callTool("list_pending", {});
      expect(result.isError).toBe(false);
      const payload = result.structuredContent as {
        pendingFollowups: ReadonlyArray<{ threadTitle: string; title: string }>;
      };
      expect(payload.pendingFollowups).toHaveLength(1);
      expect(payload.pendingFollowups[0]).toMatchObject({
        threadTitle: "Email template UX and fields",
        title: "Merge fields don't resolve in workflow-sent templates",
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("pages the thread listing, reporting the true total behind each page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const first = yield* callTool("list_threads", { limit: 2 });
      const firstPayload = first.structuredContent as {
        threads: ReadonlyArray<{ threadId: string }>;
        totalMatched: number;
        nextOffset: number | null;
      };
      expect(firstPayload.threads.map((thread) => thread.threadId)).toEqual([
        questionThreadId,
        blockedThreadId,
      ]);
      // The count is of everything matched, not of what fitted on the page —
      // this is what stops a page being reported to the user as the whole library.
      expect(firstPayload.totalMatched).toBe(5);
      expect(firstPayload.nextOffset).toBe(2);

      const second = yield* callTool("list_threads", { limit: 2, offset: 2 });
      const secondPayload = second.structuredContent as {
        threads: ReadonlyArray<{ threadId: string }>;
        nextOffset: number | null;
      };
      expect(secondPayload.threads.map((thread) => thread.threadId)).toEqual([
        busyThreadId,
        interruptedThreadId,
      ]);
      expect(secondPayload.nextOffset).toBe(4);

      // The last page reports no next offset rather than one that would return
      // an empty page, which the orchestrator would read as a remaining backlog.
      const last = yield* callTool("list_threads", { limit: 2, offset: 4 });
      const lastPayload = last.structuredContent as {
        threads: ReadonlyArray<{ threadId: string }>;
        nextOffset: number | null;
      };
      expect(lastPayload.threads.map((thread) => thread.threadId)).toEqual([idleThreadId]);
      expect(lastPayload.nextOffset).toBeNull();

      // Paging past the end is empty rather than an error; a stale offset from
      // an earlier turn should not read as a failure.
      const past = yield* callTool("list_threads", { offset: 500 });
      expect(past.isError).toBe(false);
      expect(
        (past.structuredContent as { threads: ReadonlyArray<unknown>; nextOffset: number | null })
          .threads,
      ).toHaveLength(0);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("caps each pending section independently and counts what it left out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const capped = yield* callTool("list_pending", { limit: 1, sections: ["followups"] });
      const payload = capped.structuredContent as {
        awaitingApproval: ReadonlyArray<unknown>;
        awaitingUserInput: ReadonlyArray<unknown>;
        pendingQuestions: ReadonlyArray<unknown>;
        pendingFollowups: ReadonlyArray<unknown>;
        counts: Record<string, number>;
        sections: ReadonlyArray<string>;
      };
      // Asking for one section returns only that one — the others are not
      // merely empty-by-luck, they were never gathered.
      expect(payload.sections).toEqual(["followups"]);
      expect(payload.awaitingApproval).toHaveLength(0);
      expect(payload.awaitingUserInput).toHaveLength(0);
      expect(payload.pendingQuestions).toHaveLength(0);
      expect(payload.pendingFollowups).toHaveLength(1);
      // Narrowing `sections` suppresses the item lists but not the tally. A zero
      // here would be read out to the user as "nothing else is waiting on you",
      // when in fact those sections were simply not asked for.
      expect(payload.counts).toMatchObject({
        awaitingApproval: 1,
        awaitingUserInput: 1,
        pendingFollowups: 1,
      });

      // Every section together still reports the real totals.
      const all = yield* callTool("list_pending", {});
      const allPayload = all.structuredContent as {
        counts: Record<string, number>;
        sections: ReadonlyArray<string>;
        nextOffset: number | null;
      };
      expect(allPayload.sections).toEqual(["approvals", "questions", "failed", "followups"]);
      expect(allPayload.counts.awaitingApproval).toBeGreaterThan(0);
      expect(allPayload.counts.awaitingUserInput).toBeGreaterThan(0);
      // Nothing overflowed the default cap, so there is no next page to offer.
      expect(allPayload.nextOffset).toBeNull();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("filters what is waiting by date, and refuses a date it cannot read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sinceIncluded = yield* callTool("list_pending", { since: "2026-08-05" });
      expect(
        (sinceIncluded.structuredContent as { pendingFollowups: ReadonlyArray<unknown> })
          .pendingFollowups,
      ).toHaveLength(1);

      const sinceExcluded = yield* callTool("list_pending", { since: "2026-08-06" });
      const excluded = sinceExcluded.structuredContent as {
        pendingFollowups: ReadonlyArray<unknown>;
        counts: Record<string, number>;
      };
      expect(excluded.pendingFollowups).toHaveLength(0);
      expect(excluded.counts.pendingFollowups).toBe(0);

      // An explicit `until` is exclusive to the instant: a follow-up recorded at
      // exactly 08:26:57 falls outside a window ending at 08:26:57, so adjacent
      // windows built from the same boundary cannot both claim it.
      const untilExcluded = yield* callTool("list_pending", {
        until: "2026-08-05T08:26:57.000Z",
      });
      expect(
        (untilExcluded.structuredContent as { pendingFollowups: ReadonlyArray<unknown> })
          .pendingFollowups,
      ).toHaveLength(0);

      // A follow-up is judged on its own age, not its thread's. This one was
      // recorded at 08:26 in a thread last touched at 09:04, so a bound falling
      // between the two must still return it — filtering on the thread would
      // hide exactly the stale follow-up the caller is hunting for.
      const olderThanItsThread = yield* callTool("list_pending", {
        until: "2026-08-05T08:30:00.000Z",
        sections: ["followups"],
      });
      expect(
        (olderThanItsThread.structuredContent as { pendingFollowups: ReadonlyArray<unknown> })
          .pendingFollowups,
      ).toHaveLength(1);

      // An offset-bearing bound is compared as the instant it names, not as the
      // text it was written as. 10:00+02:00 is 08:00Z, which precedes the
      // 08:26Z follow-up — comparing the raw strings would wrongly exclude it.
      const offsetBound = yield* callTool("list_pending", {
        since: "2026-08-05T10:00:00+02:00",
      });
      expect(
        (offsetBound.structuredContent as { pendingFollowups: ReadonlyArray<unknown> })
          .pendingFollowups,
      ).toHaveLength(1);

      // The obvious way to ask for a single day. A bare `until` runs to the end
      // of its day, so this is the whole of the 5th rather than a zero-width
      // window that would report the backlog as clear.
      const singleDay = yield* callTool("list_pending", {
        since: "2026-08-05",
        until: "2026-08-05",
      });
      expect(
        (singleDay.structuredContent as { pendingFollowups: ReadonlyArray<unknown> })
          .pendingFollowups,
      ).toHaveLength(1);

      // An unreadable bound fails loudly: silently ignoring it would return the
      // whole backlog to a caller that asked for one day of it.
      const nonsense = yield* callTool("list_pending", { since: "last tuesday" });
      expect(nonsense.isError).toBe(true);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("stops honouring the capability once the project is no longer designated", () =>
  Effect.scoped(
    Effect.gen(function* () {
      dispatched.length = 0;
      designatedProjectId = null;
      const listed = yield* callTool("list_threads", {});
      expect(listed.isError).toBe(true);

      const sent = yield* callTool("send_to_thread", {
        threadId: idleThreadId,
        message: "should not land",
      });
      expect(sent.isError).toBe(true);
      expect(dispatched).toHaveLength(0);

      designatedProjectId = metaProjectId;
      const recovered = yield* callTool("list_threads", {});
      expect(recovered.isError).toBe(false);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses to send to another orchestrator conversation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      dispatched.length = 0;
      const result = yield* callTool("send_to_thread", {
        threadId: siblingMetaThreadId,
        message: "you go first",
      });
      expect(result.isError).toBe(true);
      expect(dispatched).toHaveLength(0);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses to send to a thread parked on an approval, even with steering", () =>
  Effect.scoped(
    Effect.gen(function* () {
      dispatched.length = 0;
      for (const args of [
        { threadId: blockedThreadId, message: "carry on" },
        { threadId: blockedThreadId, message: "carry on", steerRunningTurn: true },
      ]) {
        const result = yield* callTool("send_to_thread", args);
        expect(result.isError).toBe(true);
      }
      expect(dispatched).toHaveLength(0);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reports an interrupted turn as interrupted, and counts it as needing attention", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* callTool("list_threads", { onlyNeedingAttention: true });
      const threads = (
        result.structuredContent as { threads: ReadonlyArray<Record<string, unknown>> }
      ).threads;
      expect(threads.find((thread) => thread.threadId === interruptedThreadId)).toMatchObject({
        phase: "interrupted",
        headline: "Turn interrupted",
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("says an archived conversation is archived rather than missing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* callTool("read_thread", { threadId: archivedThreadId });
      expect(result.isError).toBe(true);
      const text = result.content.map((entry) => ("text" in entry ? entry.text : "")).join(" ");
      expect(text).toContain("archived");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("stamps relayed turns with an orchestrator command id", () =>
  Effect.scoped(
    Effect.gen(function* () {
      dispatched.length = 0;
      const result = yield* callTool("send_to_thread", {
        threadId: idleThreadId,
        message: "fix the preview branding",
      });
      expect(result.isError).toBe(false);
      expect(dispatched[0]?.commandId.startsWith("orchestrator:")).toBe(true);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("hides conversations the user has not shared", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      delete threadAccess[busyThreadId];

      const listed = yield* callTool("list_threads", {});
      const threads = (
        listed.structuredContent as { threads: ReadonlyArray<Record<string, unknown>> }
      ).threads;
      expect(threads.some((thread) => thread.threadId === busyThreadId)).toBe(false);

      // Reading and sending both refuse, and say why.
      const read = yield* callTool("read_thread", { threadId: busyThreadId });
      expect(read.isError).toBe(true);
      const readText = read.content.map((entry) => ("text" in entry ? entry.text : "")).join(" ");
      expect(readText).toContain("not shared");

      dispatched.length = 0;
      const sent = yield* callTool("send_to_thread", {
        threadId: busyThreadId,
        message: "hello",
        steerRunningTurn: true,
      });
      expect(sent.isError).toBe(true);
      expect(dispatched).toHaveLength(0);
      resetAccess();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps unshared conversations out of search results", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      delete threadAccess[idleThreadId];
      const result = yield* callTool("search_threads", { query: "email templates" });
      expect(result.isError).toBe(false);
      expect(
        (result.structuredContent as { results: ReadonlyArray<unknown> }).results,
      ).toHaveLength(0);
      resetAccess();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reads but refuses to send when a conversation is shared for watching only", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      threadAccess[idleThreadId] = "watch";
      dispatched.length = 0;

      const read = yield* callTool("read_thread", { threadId: idleThreadId });
      expect(read.isError).toBe(false);
      expect((read.structuredContent as { thread: Record<string, unknown> }).thread).toMatchObject({
        orchestratorAccess: "watch",
      });

      const sent = yield* callTool("send_to_thread", {
        threadId: idleThreadId,
        message: "fix the branding",
      });
      expect(sent.isError).toBe(true);
      const text = sent.content.map((entry) => ("text" in entry ? entry.text : "")).join(" ");
      expect(text).toContain("not send to it");
      // Points at the per-conversation switch, because that is the one that
      // would actually lift this — no blanket override is holding it down.
      expect(text).toContain("Watch and control");
      expect(dispatched).toHaveLength(0);
      resetAccess();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("falls back to the default access for conversations with no entry of their own", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      threadAccess = {};

      // Default "none": opt-in, so nothing is visible.
      const closed = yield* callTool("list_threads", {});
      expect(
        (closed.structuredContent as { threads: ReadonlyArray<unknown> }).threads,
      ).toHaveLength(0);

      // Default "watch": opt-out, so everything is readable but nothing is
      // sendable — and the orchestrator's own threads still stay hidden.
      defaultAccess = "watch";
      const watched = yield* callTool("list_threads", {});
      const watchedThreads = (
        watched.structuredContent as { threads: ReadonlyArray<Record<string, unknown>> }
      ).threads;
      expect(watchedThreads.map((thread) => thread.threadId)).toEqual([
        questionThreadId,
        blockedThreadId,
        busyThreadId,
        interruptedThreadId,
        idleThreadId,
      ]);
      expect(watchedThreads.every((thread) => thread.orchestratorAccess === "watch")).toBe(true);

      dispatched.length = 0;
      const sent = yield* callTool("send_to_thread", {
        threadId: idleThreadId,
        message: "fix the branding",
      });
      expect(sent.isError).toBe(true);
      expect(dispatched).toHaveLength(0);

      resetAccess();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("lets a conversation override the default in either direction", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      threadAccess = {};

      // Opened up above a closed default.
      defaultAccess = "none";
      threadAccess[idleThreadId] = "control";
      const opened = yield* callTool("list_threads", {});
      expect(
        (
          opened.structuredContent as { threads: ReadonlyArray<Record<string, unknown>> }
        ).threads.map((thread) => thread.threadId),
      ).toEqual([idleThreadId]);

      // Closed below an open default: an explicit "none" outranks it, which a
      // missing entry no longer does.
      defaultAccess = "control";
      threadAccess = { [idleThreadId]: "none" };
      const closed = yield* callTool("list_threads", {});
      const closedThreads = (
        closed.structuredContent as { threads: ReadonlyArray<Record<string, unknown>> }
      ).threads;
      expect(closedThreads.some((thread) => thread.threadId === idleThreadId)).toBe(false);
      expect(closedThreads.some((thread) => thread.threadId === busyThreadId)).toBe(true);

      const read = yield* callTool("read_thread", { threadId: idleThreadId });
      expect(read.isError).toBe(true);

      resetAccess();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("opens every conversation when the orchestrator's own access control says so", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      // The state the override exists for: nothing shared, including the one
      // thread the user actually wanted followed up.
      defaultAccess = "none";
      threadAccess = { [idleThreadId]: "none" };
      accessOverride = "control-all";
      dispatched.length = 0;

      const listed = yield* callTool("list_threads", {});
      const threads = (
        listed.structuredContent as {
          threads: ReadonlyArray<Record<string, unknown>>;
          accessMode: string;
        }
      ).threads;
      // Everything, in spite of the explicit "none" — and still not the
      // orchestrator's own project, which no override reaches into.
      expect(threads.map((thread) => thread.threadId)).toEqual([
        questionThreadId,
        blockedThreadId,
        busyThreadId,
        interruptedThreadId,
        idleThreadId,
      ]);
      expect(threads.every((thread) => thread.orchestratorAccess === "control")).toBe(true);
      // Reported back, so the orchestrator can say "this is everything" rather
      // than hedging about what might not be shared.
      expect((listed.structuredContent as { accessMode: string }).accessMode).toBe("control-all");

      const read = yield* callTool("read_thread", { threadId: idleThreadId });
      expect(read.isError).toBe(false);

      const sent = yield* callTool("send_to_thread", {
        threadId: idleThreadId,
        message: "give me a status line",
      });
      expect(sent.isError).toBe(false);
      expect(dispatched).toHaveLength(1);

      // The sibling meta thread stays out of reach: two orchestrators driving
      // each other is the one thing a blanket grant must not enable.
      const sibling = yield* callTool("read_thread", { threadId: siblingMetaThreadId });
      expect(sibling.isError).toBe(true);

      resetAccess();
      dispatched.length = 0;
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reads everything but sends nowhere under a read-only override", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      defaultAccess = "none";
      threadAccess = { [idleThreadId]: "control" };
      accessOverride = "read-all";
      dispatched.length = 0;

      const listed = yield* callTool("list_threads", {});
      const threads = (
        listed.structuredContent as { threads: ReadonlyArray<Record<string, unknown>> }
      ).threads;
      expect(threads).toHaveLength(5);
      // Including the one the user had set to "control": read-all is a ceiling,
      // not just a floor.
      expect(threads.every((thread) => thread.orchestratorAccess === "watch")).toBe(true);

      const sent = yield* callTool("send_to_thread", {
        threadId: idleThreadId,
        message: "give me a status line",
      });
      expect(sent.isError).toBe(true);
      const text = sent.content.map((entry) => ("text" in entry ? entry.text : "")).join(" ");
      // Naming the per-conversation switch here would send the user somewhere
      // that cannot lift a blanket read-only setting.
      expect(text).toContain("read-only across every conversation");
      expect(text).not.toContain("right-click menu");
      expect(dispatched).toHaveLength(0);

      resetAccess();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps unshared conversations hidden under a read-shared override", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      defaultAccess = "none";
      threadAccess = { [idleThreadId]: "control", [busyThreadId]: "watch" };
      accessOverride = "read-shared";

      const listed = yield* callTool("list_threads", {});
      const threads = (
        listed.structuredContent as { threads: ReadonlyArray<Record<string, unknown>> }
      ).threads;
      // Reach is untouched — only the two shared threads — while the one set to
      // "control" is clamped to watching.
      expect(threads.map((thread) => thread.threadId)).toEqual([busyThreadId, idleThreadId]);
      expect(threads.every((thread) => thread.orchestratorAccess === "watch")).toBe(true);

      const blocked = yield* callTool("read_thread", { threadId: questionThreadId });
      expect(blocked.isError).toBe(true);

      resetAccess();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses to read a sibling orchestrator conversation even when shared", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      const read = yield* callTool("read_thread", { threadId: siblingMetaThreadId });
      expect(read.isError).toBe(true);
      const text = read.content.map((entry) => ("text" in entry ? entry.text : "")).join(" ");
      expect(text).toContain("another orchestrator conversation");
      resetAccess();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("creates a new conversation and starts it, keeping control of what it opened", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;

      const result = yield* callTool("create_thread", {
        projectTitle: "dealjourney",
        title: "Retire the legacy invoice importer",
        message: "Remove the v1 importer and its cron entry. The v2 path landed last week.",
      });
      expect(result.isError).toBe(false);
      const created = result.structuredContent as Record<string, unknown>;
      expect(created).toMatchObject({
        threadTitle: "Retire the legacy invoice importer",
        projectTitle: "dealjourney",
        orchestratorAccess: "control",
      });

      const [create, turn] = dispatched;
      expect(create).toMatchObject({
        type: "thread.create",
        projectId: workProjectId,
        title: "Retire the legacy invoice importer",
        // Local to the project: the orchestrator never prepares a worktree.
        branch: null,
        worktreePath: null,
        // The project has no default model, so it inherits the orchestrator's.
        modelSelection: { model: "claude-opus-5" },
        // Supervised unless the caller asks otherwise.
        runtimeMode: "approval-required",
      });
      expect(turn).toMatchObject({
        type: "thread.turn.start",
        threadId: (create as { threadId: string }).threadId,
        message: {
          text: "Remove the v1 importer and its cron entry. The v2 path landed last week.",
        },
      });
      // Both commands are marked as relayed rather than typed by the user.
      expect((create as { commandId: string }).commandId.startsWith("orchestrator:")).toBe(true);
      expect((turn as { commandId: string }).commandId.startsWith("orchestrator:")).toBe(true);

      // Recorded explicitly, so the orchestrator can follow up even though the
      // default is "none".
      expect(threadAccess[created.threadId as string]).toBe("control");

      resetAccess();
      dispatched.length = 0;
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("lets the orchestrator choose GPT-5.6 with the sanctioned medium effort", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;

      const result = yield* callTool("create_thread", {
        projectTitle: "dealjourney",
        title: "Run the Codex task",
        message: "Handle this with Codex.",
        model: "gpt-5.6",
      });

      expect(result.isError).toBe(false);
      expect(dispatched[0]).toMatchObject({
        type: "thread.create",
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5.6",
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
      });

      resetAccess();
      dispatched.length = 0;
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses to create a conversation it cannot place in exactly one project", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;

      const missing = yield* callTool("create_thread", {
        projectTitle: "kredin",
        title: "Something",
        message: "Do a thing",
      });
      expect(missing.isError).toBe(true);
      const missingText = missing.content
        .map((entry) => ("text" in entry ? entry.text : ""))
        .join(" ");
      // Names what does exist, so the orchestrator can ask a useful question.
      expect(missingText).toContain("dealjourney");

      // The orchestrator's own project is not a place to put work, so it is not
      // even a candidate.
      const meta = yield* callTool("create_thread", {
        projectTitle: "mission-control",
        title: "Something",
        message: "Do a thing",
      });
      expect(meta.isError).toBe(true);

      expect(dispatched).toHaveLength(0);
      resetAccess();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("honours the requested runtime mode and access on a new conversation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;

      const result = yield* callTool("create_thread", {
        projectTitle: "DEALJOURNEY",
        title: "Spike the webhook retry",
        message: "Try the retry-with-backoff approach we discussed.",
        runtimeMode: "full-access",
        access: "watch",
      });
      expect(result.isError).toBe(false);
      const created = result.structuredContent as Record<string, unknown>;
      expect(created.orchestratorAccess).toBe("watch");
      expect(dispatched[0]).toMatchObject({ runtimeMode: "full-access" });
      expect(threadAccess[created.threadId as string]).toBe("watch");

      resetAccess();
      dispatched.length = 0;
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("does not resurrect access the user revoked while create_thread was running", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;

      // The user revokes another conversation mid-flight. `create_thread` reads
      // no map of its own and writes a single entry, so the revocation stands.
      delete threadAccess[busyThreadId];

      const result = yield* callTool("create_thread", {
        projectTitle: "dealjourney",
        title: "Unrelated work",
        message: "Start on the unrelated thing.",
      });
      expect(result.isError).toBe(false);

      const created = result.structuredContent as Record<string, unknown>;
      expect(threadAccess[created.threadId as string]).toBe("control");
      expect(threadAccess[busyThreadId]).toBeUndefined();

      resetAccess();
      dispatched.length = 0;
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("surfaces the questions a conversation is parked on, and answers one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;

      const read = yield* callTool("read_thread", { threadId: questionThreadId });
      expect(read.isError).toBe(false);
      const pendingQuestions = (
        read.structuredContent as {
          pendingQuestions: ReadonlyArray<Record<string, unknown>>;
        }
      ).pendingQuestions;
      // Only the open request: one was resolved, and one the provider forgot.
      expect(pendingQuestions).toHaveLength(1);
      expect(pendingQuestions[0]).toMatchObject({
        threadId: questionThreadId,
        requestId: "request-open",
        threadTitle: "Pipeline and win-rate metrics",
      });
      expect(pendingQuestions[0]?.questions).toMatchObject([
        {
          questionId: blastRadiusQuestion.id,
          header: "Blast radius",
          multiSelect: false,
          // The empty description survives rather than sinking the question.
          options: [{ label: "Fix the shared metrics" }, { label: "Email-only", description: "" }],
        },
      ]);

      // list_pending carries the same set, so the choice can be put to the user
      // without opening each thread.
      const pending = yield* callTool("list_pending", {});
      expect(
        (pending.structuredContent as { pendingQuestions: ReadonlyArray<{ requestId: string }> })
          .pendingQuestions,
      ).toMatchObject([{ requestId: "request-open", threadId: questionThreadId }]);

      // The label is matched case-insensitively but sent back in the question's
      // own casing, and requestId can be left off while only one is open.
      const answered = yield* callTool("answer_thread_question", {
        threadId: questionThreadId,
        answers: [
          { questionId: blastRadiusQuestion.id, selectedOptions: ["fix the shared METRICS"] },
        ],
      });
      expect(answered.isError).toBe(false);
      expect(answered.structuredContent).toMatchObject({
        threadId: questionThreadId,
        requestId: "request-open",
        answered: [
          { questionId: blastRadiusQuestion.id, selectedOptions: ["Fix the shared metrics"] },
        ],
      });

      expect(dispatched).toHaveLength(1);
      const command = dispatched[0] as unknown as {
        type: string;
        threadId: string;
        requestId: string;
        answers: Record<string, unknown>;
        commandId: string;
      };
      expect(command.type).toBe("thread.user-input.respond");
      expect(command.threadId).toBe(questionThreadId);
      expect(command.requestId).toBe("request-open");
      // Keyed by question text, which is what the provider looks answers up by,
      // and a single-select question sends a bare string rather than an array.
      expect(command.answers).toEqual({ [blastRadiusQuestion.id]: "Fix the shared metrics" });
      expect(command.commandId.startsWith("orchestrator:")).toBe(true);

      dispatched.length = 0;
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("passes a custom answer through instead of forcing the nearest option", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;

      const result = yield* callTool("answer_thread_question", {
        threadId: questionThreadId,
        requestId: "request-open",
        answers: [
          {
            questionId: blastRadiusQuestion.id,
            selectedOptions: ["Email-only"],
            // Wins over the selection: the user said something the options do
            // not cover.
            customAnswer: "Fix both, but do the web page in a separate turn",
          },
        ],
      });
      expect(result.isError).toBe(false);
      expect((dispatched[0] as unknown as { answers: Record<string, unknown> }).answers).toEqual({
        [blastRadiusQuestion.id]: "Fix both, but do the web page in a separate turn",
      });

      dispatched.length = 0;
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses answers it cannot map to the question that was actually asked", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;

      // An option label the question never offered.
      const invented = yield* callTool("answer_thread_question", {
        threadId: questionThreadId,
        answers: [{ questionId: blastRadiusQuestion.id, selectedOptions: ["Do nothing"] }],
      });
      expect(invented.isError).toBe(true);

      // A question id from some other request.
      const wrongQuestion = yield* callTool("answer_thread_question", {
        threadId: questionThreadId,
        answers: [{ questionId: "Which report first?", selectedOptions: ["Pipeline"] }],
      });
      expect(wrongQuestion.isError).toBe(true);

      // A request that is no longer open.
      const stale = yield* callTool("answer_thread_question", {
        threadId: questionThreadId,
        requestId: "request-answered",
        answers: [{ questionId: blastRadiusQuestion.id, selectedOptions: ["Email-only"] }],
      });
      expect(stale.isError).toBe(true);

      // Two options for a single-select question.
      const tooMany = yield* callTool("answer_thread_question", {
        threadId: questionThreadId,
        answers: [
          {
            questionId: blastRadiusQuestion.id,
            selectedOptions: ["Email-only", "Fix the shared metrics"],
          },
        ],
      });
      expect(tooMany.isError).toBe(true);

      // A thread that is not waiting on anything.
      const notWaiting = yield* callTool("answer_thread_question", {
        threadId: idleThreadId,
        answers: [{ questionId: blastRadiusQuestion.id, selectedOptions: ["Email-only"] }],
      });
      expect(notWaiting.isError).toBe(true);

      expect(dispatched).toHaveLength(0);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("will not answer a question in a watch-only conversation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;
      threadAccess = { ...threadAccess, [questionThreadId]: "watch" };

      // Readable...
      const read = yield* callTool("read_thread", { threadId: questionThreadId });
      expect(read.isError).toBe(false);
      expect(
        (read.structuredContent as { pendingQuestions: ReadonlyArray<unknown> }).pendingQuestions,
      ).toHaveLength(1);

      // ...but not answerable.
      const answered = yield* callTool("answer_thread_question", {
        threadId: questionThreadId,
        answers: [
          { questionId: blastRadiusQuestion.id, selectedOptions: ["Fix the shared metrics"] },
        ],
      });
      expect(answered.isError).toBe(true);
      expect(dispatched).toHaveLength(0);

      resetAccess();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("tells send_to_thread callers to answer the question instead", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;

      const result = yield* callTool("send_to_thread", {
        threadId: questionThreadId,
        message: "just pick the first one",
      });
      expect(result.isError).toBe(true);
      const text = result.content.map((entry) => ("text" in entry ? entry.text : "")).join(" ");
      expect(text).toContain("answer_thread_question");
      expect(dispatched).toHaveLength(0);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("closes a follow-up, carrying the whole record through untouched", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;

      const result = yield* callTool("resolve_followup", {
        threadId: idleThreadId,
        followupId: "followup-1",
        status: "done",
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        threadId: idleThreadId,
        followupId: "followup-1",
        status: "done",
      });

      expect(dispatched).toHaveLength(1);
      const command = dispatched[0] as {
        type: string;
        commandId: string;
        followup: Record<string, unknown>;
      };
      expect(command.type).toBe("thread.followup.upsert");
      expect(command.commandId.startsWith("orchestrator:")).toBe(true);
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

      resetAccess();
      dispatched.length = 0;
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("is idempotent and refuses unknown follow-up ids", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;

      // followup-2 is already dismissed, so re-dismissing appends nothing.
      const repeat = yield* callTool("resolve_followup", {
        threadId: idleThreadId,
        followupId: "followup-2",
        status: "dismissed",
      });
      expect(repeat.isError).toBe(false);
      expect(dispatched).toHaveLength(0);

      const unknown = yield* callTool("resolve_followup", {
        threadId: idleThreadId,
        followupId: "followup-does-not-exist",
        status: "done",
      });
      expect(unknown.isError).toBe(true);
      const text = unknown.content.map((entry) => ("text" in entry ? entry.text : "")).join(" ");
      // Names the ids that do exist rather than leaving the agent to guess.
      expect(text).toContain("followup-1");
      expect(dispatched).toHaveLength(0);

      resetAccess();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses to close follow-ups on a watch-only conversation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      threadAccess[idleThreadId] = "watch";
      dispatched.length = 0;

      const result = yield* callTool("resolve_followup", {
        threadId: idleThreadId,
        followupId: "followup-1",
        status: "done",
      });
      expect(result.isError).toBe(true);
      const text = result.content.map((entry) => ("text" in entry ? entry.text : "")).join(" ");
      expect(text).toContain("not close its follow-ups");
      expect(dispatched).toHaveLength(0);

      resetAccess();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reports what a conversation changed, aggregated across its turns", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();

      const result = yield* callTool("read_thread_changes", { threadId: idleThreadId });
      expect(result.isError).toBe(false);
      const changes = result.structuredContent as {
        files: ReadonlyArray<{ path: string; churnAdditions: number; churnDeletions: number }>;
        totalChurnAdditions: number;
        totalChurnDeletions: number;
        turns: ReadonlyArray<{ turnCount: number; fileCount: number }>;
        patch: string | null;
        branch: string | null;
      };

      // Per-file counts sum across turns, most-changed first.
      expect(changes.files).toEqual([
        { path: "src/templates.ts", churnAdditions: 43, churnDeletions: 5 },
        { path: "src/mail.ts", churnAdditions: 2, churnDeletions: 1 },
      ]);
      expect(changes.totalChurnAdditions).toBe(45);
      expect(changes.totalChurnDeletions).toBe(6);
      // The errored checkpoint is excluded outright — its numbers are not real.
      expect(changes.turns.map((turn) => turn.turnCount)).toEqual([1, 2]);
      expect(changes.branch).toBe("staging");
      // The patch is opt-in, because it is the expensive half.
      expect(changes.patch).toBeNull();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("returns a patch only when asked, and can narrow it to one turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();

      const whole = yield* callTool("read_thread_changes", {
        threadId: idleThreadId,
        includePatch: true,
      });
      expect(whole.isError).toBe(false);
      expect((whole.structuredContent as { patch: string | null }).patch).toContain(
        "full thread diff",
      );

      const single = yield* callTool("read_thread_changes", {
        threadId: idleThreadId,
        includePatch: true,
        turnCount: 2,
      });
      expect(single.isError).toBe(false);
      expect((single.structuredContent as { patch: string | null }).patch).toContain("turn 2");

      // A turn with no checkpoint is an error naming the ones that exist,
      // rather than a silently empty diff.
      const missing = yield* callTool("read_thread_changes", {
        threadId: idleThreadId,
        includePatch: true,
        turnCount: 9,
      });
      expect(missing.isError).toBe(true);
      const text = missing.content.map((entry) => ("text" in entry ? entry.text : "")).join(" ");
      expect(text).toContain("1, 2");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("will not show changes for a conversation that is not shared", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      threadAccess[idleThreadId] = "none";

      const result = yield* callTool("read_thread_changes", { threadId: idleThreadId });
      expect(result.isError).toBe(true);
      const text = result.content.map((entry) => ("text" in entry ? entry.text : "")).join(" ");
      expect(text).toContain("not shared");

      // Watching is enough to review code — it is a read.
      threadAccess[idleThreadId] = "watch";
      const watched = yield* callTool("read_thread_changes", { threadId: idleThreadId });
      expect(watched.isError).toBe(false);

      resetAccess();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("gives a worktree conversation its own branch and checkout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;

      const result = yield* callTool("create_thread", {
        projectTitle: "dealjourney",
        title: "Second track",
        message: "Work on this without disturbing the other thread.",
        envMode: "worktree",
      });
      expect(result.isError).toBe(false);
      const created = result.structuredContent as Record<string, unknown>;

      expect(created.worktreePath).toEqual(expect.stringContaining("C:/worktrees/dealjourney/"));
      expect(typeof created.branch).toBe("string");
      // A generated branch, never the base one — git refuses to check out a
      // branch a second worktree already holds.
      expect(created.branch).not.toBe("staging");
      expect(created.setupScript).toBe("started");

      const metaUpdate = dispatched.find((command) => command.type === "thread.meta.update") as
        | { branch: string; worktreePath: string }
        | undefined;
      expect(metaUpdate?.branch).toBe(created.branch);
      expect(metaUpdate?.worktreePath).toBe(created.worktreePath);

      // Order matters: the thread exists, gets its worktree, then runs.
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.meta.update",
        "thread.turn.start",
      ]);

      resetAccess();
      dispatched.length = 0;
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("creates nothing when the worktree cannot be prepared", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;
      worktreeFailure = "fatal: 'staging' is already checked out";

      const result = yield* callTool("create_thread", {
        projectTitle: "dealjourney",
        title: "Doomed",
        message: "This should not survive.",
        envMode: "worktree",
      });
      expect(result.isError).toBe(true);
      const text = result.content.map((entry) => ("text" in entry ? entry.text : "")).join(" ");
      // The git error is surfaced verbatim rather than swallowed.
      expect(text).toContain("already checked out");

      // The half-created thread is rolled back, and no turn was ever started.
      expect(dispatched.map((command) => command.type)).toEqual(["thread.create", "thread.delete"]);

      resetAccess();
      dispatched.length = 0;
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses a worktree in a project git cannot branch from", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;
      gitLocalStatus = { isRepo: false, refName: null };

      const result = yield* callTool("create_thread", {
        projectTitle: "dealjourney",
        title: "No repo here",
        message: "This should not survive either.",
        envMode: "worktree",
      });
      expect(result.isError).toBe(true);
      const text = result.content.map((entry) => ("text" in entry ? entry.text : "")).join(" ");
      expect(text).toContain("envMode:'local'");
      expect(dispatched.map((command) => command.type)).toEqual(["thread.create", "thread.delete"]);

      resetAccess();
      dispatched.length = 0;
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("still defaults to sharing the project checkout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;

      const result = yield* callTool("create_thread", {
        projectTitle: "dealjourney",
        title: "Local by default",
        message: "No worktree wanted.",
      });
      expect(result.isError).toBe(false);
      const created = result.structuredContent as Record<string, unknown>;
      expect(created.branch).toBeNull();
      expect(created.worktreePath).toBeNull();
      expect(created.setupScript).toBeNull();
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
      ]);

      resetAccess();
      dispatched.length = 0;
    }),
  ).pipe(Effect.provide(TestLayer)),
);
