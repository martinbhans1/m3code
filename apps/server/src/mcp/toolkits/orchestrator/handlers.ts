import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_ORCHESTRATOR_ACCESS_OVERRIDE,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type OrchestratorAccessOverride,
  type OrchestratorThreadAccess,
  FOLLOWUP_ACTIVITY_KIND,
  isProviderAvailable,
  type IsoDateTime,
  MessageId,
  type OrchestrationFollowup,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ModelSelection,
  type ProjectId,
  ThreadId,
  UserInputQuestion,
} from "@t3tools/contracts";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import { resolveOrchestratorThreadAccess } from "@t3tools/shared/orchestratorAccess";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CheckpointDiffQuery } from "../../../checkpointing/Services/CheckpointDiffQuery.ts";
import { ConversationSearch } from "../../../conversationSearch/ConversationSearch.ts";
import { GitWorkflowService } from "../../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSetupScriptRunner } from "../../../project/Services/ProjectSetupScriptRunner.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ServerRuntimeStartup } from "../../../serverRuntimeStartup.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  deriveFollowupRecords,
  derivePendingFollowups,
  describeThreadState,
} from "../followup/records.ts";
import { OrchestratorToolError, OrchestratorToolkit } from "./tools.ts";

const DEFAULT_THREAD_LIMIT = 40;
const DEFAULT_MESSAGE_LIMIT = 12;
const DEFAULT_SEARCH_LIMIT = 10;
/**
 * Per-section cap for `list_pending`. Deliberately smaller than the thread
 * listing's: this tool returns four sections plus the full text of every
 * question on the page, so its result grows several times faster per item.
 */
const DEFAULT_PENDING_LIMIT = 25;
/** Fixed order, so the reported `sections` list reads the same way every time. */
const PENDING_SECTIONS = ["approvals", "questions", "failed", "followups"] as const;
type PendingSection = (typeof PENDING_SECTIONS)[number];
/**
 * Messages are for orientation, not review. Long assistant turns get cut so a
 * single `read_thread` cannot swamp the orchestrator's context — the whole
 * point of this surface is that it stays cheap enough to re-query every turn
 * instead of remembering.
 */
const MAX_MESSAGE_CHARS = 1_000;
/**
 * Ceiling on the message text one `read_thread` can return, however the caller
 * splits it between message count and per-message length. Raising `messageChars`
 * to read one long note in full is the point; sixty of them at that length is
 * not, and no single tool result should be able to fill the orchestrator's
 * context on its own.
 */
const MAX_READ_THREAD_CHARS = 60_000;
/**
 * Patch budget for `read_thread_changes`. Sized to match the range-diff cap the
 * git driver already uses for LLM-bound patches (GitVcsDriverCore), not the
 * 10MB safety limit on the checkpoint driver — that one exists to stop runaway
 * processes, and handing its output to an agent would bury the conversation.
 */
const MAX_PATCH_CHARS = 59_000;
/** Enough to see the shape of a change; beyond this the file list stops being scannable. */
const MAX_CHANGED_FILES = 100;

type ThreadSummary = ReturnType<typeof summarizeThread>;

/**
 * Access that actually grants something. Threads resolving to "none" are
 * filtered out before anything summarizes them, so the summary schema only ever
 * has to describe these two.
 */
type SharedThreadAccess = Exclude<OrchestratorThreadAccess, "none">;

/**
 * Sharing is a setting, not a property of the thread, and it can be closed by
 * the per-conversation entry, by the global baseline, or by the orchestrator's
 * own access override. The wording has to make clear that this is a setting
 * rather than a missing thread, or the orchestrator will report it to the user
 * as deleted — and it has to name the switch that would actually open it,
 * because the per-conversation one is the slow way round when the user is on a
 * phone and wants everything opened at once.
 */
const notShared = (threadId: string) =>
  new OrchestratorToolError({
    message: `Conversation ${threadId} is not shared with you. Two switches can open it: the access control in *this* conversation's composer, set to "Read everything" or "Read and steer everything", opens every conversation at once; the orchestrator control in *that* conversation's composer (or its right-click menu) opens just that one. Both are the user's to change — tell them which you need rather than working around it.`,
  });

/**
 * The remedy line for "you can see it but you may not act on it".
 *
 * Which switch to point at depends on why: a read-only override cannot be
 * lifted per conversation, so telling the user to go raise that thread's own
 * setting would send them somewhere that changes nothing.
 */
const raiseToControlHint = (override: OrchestratorAccessOverride): string =>
  override === "read-all" || override === "read-shared"
    ? 'You are set to read-only across every conversation, so raising this one on its own would not help — the user lifts that from the access control in this conversation\'s composer, by choosing "Read and steer everything".'
    : 'The user raises it to "Watch and control" from the orchestrator control in that conversation\'s composer or its right-click menu — or opens every conversation at once with "Read and steer everything" in the access control in this conversation\'s composer.';

const notOrchestrator = new OrchestratorToolError({
  message:
    "This thread is not the orchestrator. Cross-thread tools are limited to threads inside the project designated in Settings → General → Orchestrator project.",
});

/**
 * Authorize a call, and resolve which project is currently the orchestrator.
 *
 * The credential's capability is not sufficient on its own: it is minted once
 * per provider session and lives for hours, so a session that started while the
 * setting pointed here keeps its capability after the user switches the setting
 * off. Re-reading the setting and the thread's project on every call makes
 * withdrawal take effect immediately rather than whenever the session happens
 * to restart. Both lookups deny on failure.
 */
const requireOrchestrator = Effect.fn("OrchestratorToolkit.requireCapability")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("orchestrator")) {
    return yield* notOrchestrator;
  }

  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings.pipe(
    Effect.map((value) => ({
      orchestratorProjectId: value.orchestratorProjectId,
      defaultAccess: value.defaultOrchestratorThreadAccess,
      access: value.orchestratorThreadAccess as Readonly<Record<string, OrchestratorThreadAccess>>,
      accessOverride: value.orchestratorAccessOverride,
    })),
    Effect.orElseSucceed(() => ({
      orchestratorProjectId: null,
      // Settings that cannot be read must not silently widen access, so the
      // failure path is the closed one regardless of what the user configured.
      defaultAccess: "none" as OrchestratorThreadAccess,
      access: {} as Readonly<Record<string, OrchestratorThreadAccess>>,
      // Same reasoning: no override rather than the permissive one the user may
      // well have set.
      accessOverride: DEFAULT_ORCHESTRATOR_ACCESS_OVERRIDE as OrchestratorAccessOverride,
    })),
  );
  const { orchestratorProjectId } = settings;
  if (orchestratorProjectId === null) return yield* notOrchestrator;

  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const callerThread = yield* projectionSnapshotQuery
    .getThreadShellById(invocation.threadId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (!(Option.isSome(callerThread) && callerThread.value.projectId === orchestratorProjectId)) {
    return yield* notOrchestrator;
  }

  return {
    invocation,
    orchestratorProjectId,
    /** What the orchestrator's own access control is currently set to. */
    accessOverride: settings.accessOverride,
    /**
     * Resolved access for a thread: the blanket override if one is in force,
     * otherwise its own entry, otherwise the configured baseline. "none" means
     * the orchestrator cannot see it.
     */
    accessFor: (threadId: string): OrchestratorThreadAccess =>
      resolveOrchestratorThreadAccess({
        perConversation: settings.access[threadId],
        defaultAccess: settings.defaultAccess,
        override: settings.accessOverride,
      }),
  };
});

const truncate = (
  text: string,
  maxChars: number = MAX_MESSAGE_CHARS,
): { text: string; truncated: boolean } =>
  text.length > maxChars
    ? { text: `${text.slice(0, maxChars)}…`, truncated: true }
    : { text, truncated: false };

/**
 * Every activity kind the orchestrator derives anything from, and nothing else.
 *
 * `derivePendingFollowups` reads the first, `derivePendingUserInputs` the next
 * three, `derivePendingApprovals` the last three. Passing this to a
 * kind-filtered query rather than loading the whole activity log is the
 * difference between reading kilobytes and megabytes per thread — across this
 * projection these kinds are a fifth of a percent of the rows and a tenth of a
 * percent of the payload bytes.
 *
 * Adding a kind to any derivation means adding it here, or the rows it needs
 * will simply not be fetched — and the symptom is silence, not an error.
 */
const ORCHESTRATOR_ACTIVITY_KINDS = [
  FOLLOWUP_ACTIVITY_KIND,
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
] as const;

/**
 * The follow-ups of a thread that have been closed out, most recently resolved
 * first: what was spun off elsewhere, done, or dismissed.
 *
 * Reported alongside the pending ones so the orchestrator can answer "was this
 * ever picked up?" without being told only about what is still open — a
 * follow-up handed to another conversation stops being pending the moment it is
 * spun off, and would otherwise vanish from every surface here.
 */
function deriveResolvedFollowups(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Array<OrchestrationFollowup> {
  return [...deriveFollowupRecords(activities).values()]
    .filter((followup) => followup.status !== "pending")
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * How many closed follow-ups `read_thread` reports. Enough to see what has
 * already been handled on a busy thread without turning a read into a history
 * dump — the pending ones are the part that still needs somebody.
 */
const MAX_RESOLVED_FOLLOWUPS = 10;

/** Shape closed follow-ups for a tool result, joining each spin-off to its thread. */
const summarizeResolvedFollowups = Effect.fn("orchestrator.summarizeResolvedFollowups")(function* (
  followups: ReadonlyArray<OrchestrationFollowup>,
) {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  // Deduplicated: several follow-ups can have gone to the same conversation.
  const threadIds = [
    ...new Set(
      followups
        .map((followup) => followup.implementationThreadId)
        .filter((threadId): threadId is ThreadId => threadId !== null),
    ),
  ];
  const shells = new Map(
    yield* Effect.forEach(threadIds, (threadId) =>
      projectionSnapshotQuery.getThreadShellById(threadId).pipe(
        // A conversation since deleted or archived reads as absent. That is a
        // null link, not a reason to fail the read.
        Effect.orElseSucceed(() => Option.none<OrchestrationThreadShell>()),
        Effect.map(
          (shell) =>
            [
              threadId,
              Option.match(shell, {
                onNone: () => null,
                onSome: (target) => ({
                  threadId: target.id,
                  title: target.title,
                  state: describeThreadState(target),
                  updatedAt: target.updatedAt,
                }),
              }),
            ] as const,
        ),
      ),
    ),
  );

  return followups.map((followup) => ({
    followupId: followup.id,
    title: followup.title,
    status: followup.status as "spunOff" | "done" | "dismissed",
    updatedAt: followup.updatedAt,
    implementationThread:
      followup.implementationThreadId === null
        ? null
        : (shells.get(followup.implementationThreadId) ?? null),
  }));
});

/**
 * The questions a thread is currently parked on, oldest first.
 *
 * Pending user input rides the activity log the same way approvals do: a
 * `user-input.requested` activity carries the questions, and the matching
 * `user-input.resolved` retires it. The failure kind is folded in too, because
 * a provider that has forgotten the request answers `stale`/`unknown` — the
 * request is dead but nothing ever writes the resolved activity, so without it
 * the orchestrator would keep offering to answer a question no longer there.
 *
 * Mirrors `derivePendingUserInputs` on the client; kept separate because that
 * one lives in the app bundles.
 */
/**
 * Parsed by hand rather than through the `UserInputQuestion` schema: its string
 * fields are `TrimmedNonEmptyString`, but the Claude adapter forwards option
 * descriptions unsanitized, so a model that omits one produces `description: ""`
 * — which a schema decode would reject. Rejecting the whole set for that would
 * make a question the user can plainly see in the app invisible here, and have
 * the orchestrator tell them the thread is not waiting on anything. The client
 * derivations are equally permissive, and drop bad questions one at a time.
 */
function parseUserInputQuestions(value: unknown): Array<UserInputQuestion> | null {
  if (!Array.isArray(value)) return null;

  const parsed: Array<UserInputQuestion> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const question = entry as Record<string, unknown>;
    if (
      typeof question.id !== "string" ||
      question.id.length === 0 ||
      typeof question.header !== "string" ||
      typeof question.question !== "string" ||
      !Array.isArray(question.options)
    ) {
      continue;
    }

    const options: Array<{ label: string; description: string }> = [];
    for (const rawOption of question.options) {
      if (!rawOption || typeof rawOption !== "object") continue;
      const option = rawOption as Record<string, unknown>;
      if (typeof option.label !== "string" || option.label.length === 0) continue;
      options.push({
        label: option.label,
        description: typeof option.description === "string" ? option.description : "",
      });
    }
    // A question with no usable option can still be answered with free text, so
    // it is kept rather than dropped.

    parsed.push({
      id: question.id,
      header: question.header,
      question: question.question,
      options,
      multiSelect: question.multiSelect === true,
    } as UserInputQuestion);
  }

  return parsed.length > 0 ? parsed : null;
}

/**
 * Kept in step with `ProjectionPipeline`'s pending count and the client's
 * `isStalePendingRequestFailureDetail`: a marker missing here leaves a dead
 * request on offer that the thread badge has already dropped, and answering it
 * would go nowhere.
 */
const STALE_USER_INPUT_FAILURE_MARKERS = [
  "stale pending user-input request",
  "unknown pending user-input request",
  "unknown pending user input request",
  "unknown pending codex user input request",
];

/**
 * The approval requests a thread is still stopped on, oldest first.
 *
 * The projection tracks only that an approval is outstanding, so what it is
 * *for* has to be recovered from the activity the provider wrote when it asked.
 * Mirrors the client's own derivation, including the stale-failure case: a
 * request the provider has since forgotten can never be answered, and leaving
 * it listed would have the orchestrator offer the user a dead choice.
 */
function derivePendingApprovals(activities: ReadonlyArray<OrchestrationThreadActivity>): Array<{
  requestId: string;
  requestKind: "command" | "file-read" | "file-change" | null;
  detail: string | null;
  createdAt: string;
}> {
  const openByRequestId = new Map<
    string,
    {
      requestId: string;
      requestKind: "command" | "file-read" | "file-change" | null;
      detail: string | null;
      createdAt: string;
    }
  >();

  // Sequence first, timestamp as a tie-break — same ordering as the pending
  // question derivation, and for the same reason.
  const ordered = activities.toSorted(
    (left, right) =>
      (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
      left.createdAt.localeCompare(right.createdAt),
  );

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      typeof payload?.requestId === "string" && payload.requestId.length > 0
        ? payload.requestId
        : null;
    if (!requestId) continue;

    if (activity.kind === "approval.requested") {
      const requestKind =
        payload?.requestKind === "command" ||
        payload?.requestKind === "file-read" ||
        payload?.requestKind === "file-change"
          ? payload.requestKind
          : null;
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        detail: typeof payload?.detail === "string" ? payload.detail : null,
        createdAt: activity.createdAt,
      });
      continue;
    }

    if (
      activity.kind === "approval.resolved" ||
      activity.kind === "provider.approval.respond.failed"
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function derivePendingUserInputs(activities: ReadonlyArray<OrchestrationThreadActivity>): Array<{
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}> {
  const openByRequestId = new Map<
    string,
    { requestId: ApprovalRequestId; createdAt: string; questions: ReadonlyArray<UserInputQuestion> }
  >();

  // Sequence first, timestamp only as a tie-break: retirement depends on the
  // resolved activity landing after the request it retires, and wall-clock
  // timestamps can tie or go backwards. The client orders the same way.
  const ordered = activities.toSorted(
    (left, right) =>
      (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
      left.createdAt.localeCompare(right.createdAt),
  );

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      typeof payload?.requestId === "string" && payload.requestId.length > 0
        ? payload.requestId
        : null;
    if (!requestId) continue;

    if (activity.kind === "user-input.requested") {
      const questions = parseUserInputQuestions(payload?.questions);
      // A request whose questions will not parse at all cannot be answered
      // from here, so leave it out rather than advertising an unanswerable one.
      if (questions === null) continue;
      openByRequestId.set(requestId, {
        requestId: ApprovalRequestId.make(requestId),
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved") {
      openByRequestId.delete(requestId);
      continue;
    }

    if (activity.kind === "provider.user-input.respond.failed") {
      const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : "";
      if (STALE_USER_INPUT_FAILURE_MARKERS.some((marker) => detail.includes(marker))) {
        openByRequestId.delete(requestId);
      }
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

/** Shape `derivePendingUserInputs` output for a tool result. */
/** Shape `derivePendingApprovals` output for a tool result. */
const toPendingApprovals = (
  pending: ReturnType<typeof derivePendingApprovals>,
  thread: { threadId: ThreadId; threadTitle: string; projectTitle: string },
) =>
  pending.map((request) => ({
    ...thread,
    requestId: request.requestId,
    requestKind: request.requestKind,
    detail: request.detail,
    createdAt: request.createdAt as IsoDateTime,
  }));

const toPendingQuestionSets = (
  pending: ReturnType<typeof derivePendingUserInputs>,
  thread: { threadId: ThreadId; threadTitle: string; projectTitle: string },
) =>
  pending.map((request) => ({
    ...thread,
    requestId: request.requestId,
    createdAt: request.createdAt as IsoDateTime,
    questions: request.questions.map((question) => ({
      questionId: question.id,
      header: question.header,
      question: question.question,
      multiSelect: question.multiSelect === true,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
    })),
  }));

function summarizeThread(input: {
  readonly environmentId: McpInvocationContext.McpInvocationScope["environmentId"];
  readonly thread: OrchestrationThreadShell;
  readonly projectTitle: string;
  readonly access: SharedThreadAccess;
  /** Epoch milliseconds, for deciding whether a running turn has gone silent. */
  readonly now: number;
  /** True for one of the orchestrator's own earlier conversations. */
  readonly isOrchestratorConversation: boolean;
}) {
  const { thread, projectTitle } = input;
  const awareness = projectThreadAwareness({
    environmentId: input.environmentId,
    project: { title: projectTitle },
    thread,
    now: input.now,
  });

  // Awareness only names the states its push notifications care about and
  // returns null for everything else — including a turn the user interrupted,
  // which must not be reported as "never run" or it drops out of the "waiting
  // on you" list entirely.
  const fallbackPhase: "interrupted" | "idle" =
    thread.latestTurn?.state === "interrupted" ? "interrupted" : "idle";
  const fallbackHeadline =
    fallbackPhase === "interrupted"
      ? "Turn interrupted"
      : thread.latestTurn === null
        ? "No turns yet"
        : "Idle";

  return {
    threadId: thread.id,
    title: thread.title,
    projectId: thread.projectId,
    projectTitle,
    branch: thread.branch,
    phase: awareness?.phase ?? fallbackPhase,
    headline: awareness?.headline ?? fallbackHeadline,
    detail: awareness?.detail ?? null,
    model: thread.modelSelection.model,
    runtimeMode: thread.runtimeMode,
    updatedAt: thread.updatedAt,
    latestUserMessageAt: thread.latestUserMessageAt,
    // A stale turn is not an active one: reporting it as active would have the
    // orchestrator refuse to send into a thread whose turn died weeks ago.
    hasActiveTurn:
      awareness?.phase !== "stale" &&
      (thread.latestTurn?.state === "running" ||
        thread.session?.status === "running" ||
        thread.session?.status === "starting"),
    awaitingApproval: thread.hasPendingApprovals,
    awaitingUserInput: thread.hasPendingUserInput,
    hasPendingFollowups: thread.hasPendingFollowups,
    archived: thread.archivedAt !== null,
    pinned: thread.pinnedAt !== null,
    orchestratorAccess: input.access,
    isOrchestratorConversation: input.isOrchestratorConversation,
  };
}

const needsAttention = (thread: ThreadSummary): boolean =>
  thread.awaitingApproval ||
  thread.awaitingUserInput ||
  thread.hasPendingFollowups ||
  thread.phase === "failed" ||
  // Stopped mid-work and never returned to — the case most likely to be
  // forgotten, since nothing in the UI nags about it.
  thread.phase === "interrupted";

const snapshotError = (action: string) => (cause: unknown) =>
  new OrchestratorToolError({
    message: `Failed to ${action}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

/**
 * Load every thread the caller asked about, joined to its project title.
 * Archived threads live in a separate query so normal navigation never
 * hydrates them; the orchestrator opts in explicitly.
 */
const loadThreadSummaries = Effect.fn("OrchestratorToolkit.loadThreadSummaries")(
  function* (options: {
    readonly environmentId: McpInvocationContext.McpInvocationScope["environmentId"];
    readonly includeArchived: boolean;
    readonly accessFor: (threadId: string) => OrchestratorThreadAccess;
    /** Threads in this project are the orchestrator's own: readable, never writable. */
    readonly orchestratorProjectId: ProjectId;
    /** The orchestrator conversation asking, which is left out of its own results. */
    readonly callerThreadId: ThreadId;
  }) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const shell = yield* projectionSnapshotQuery
      .getShellSnapshot()
      .pipe(Effect.mapError(snapshotError("read the thread snapshot")));
    const archived = options.includeArchived
      ? yield* projectionSnapshotQuery
          .getArchivedShellSnapshot()
          .pipe(Effect.mapError(snapshotError("read archived threads")))
      : null;

    const projectTitles = new Map<ProjectId, string>();
    for (const project of [...shell.projects, ...(archived?.projects ?? [])]) {
      projectTitles.set(project.id, project.title);
    }

    // Threads resolving to "none" are dropped here, before anything else looks
    // at them — they are absent from every listing rather than present and
    // unsendable.
    //
    // The orchestrator's own earlier conversations are the exception, and they
    // are listed as "watch" whatever the sharing settings say. They are the
    // user's own meta conversations, sitting behind the same row as this one,
    // and without them every new orchestrator conversation starts amnesiac —
    // re-deciding what the last one decided and offering work it already handed
    // out. "watch" rather than "control" is the whole point: readable, so a
    // session can pick up where the last left off; never writable, so two
    // orchestrators cannot drive each other. The caller's own thread is left
    // out — it can already see itself, and listing it invites it to reason
    // about its own state as though it were somebody else's.
    return (
      [...shell.threads, ...(archived?.threads ?? [])]
        .flatMap((thread) => {
          const isOrchestratorConversation = thread.projectId === options.orchestratorProjectId;
          if (isOrchestratorConversation && thread.id === options.callerThreadId) return [];
          const access = isOrchestratorConversation
            ? ("watch" as const)
            : options.accessFor(thread.id);
          return access === "none"
            ? []
            : [
                summarizeThread({
                  environmentId: options.environmentId,
                  thread,
                  projectTitle: projectTitles.get(thread.projectId) ?? "Unknown project",
                  access,
                  now,
                  isOrchestratorConversation,
                }),
              ];
        })
        // Thread id breaks ties so the order is total rather than merely mostly
        // sorted. Paging issues one query per page, and two threads sharing an
        // `updatedAt` could otherwise come back in a different relative order each
        // time — which shows up as a thread appearing on both pages, or on
        // neither, for no reason the user could ever diagnose.
        .toSorted(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            left.threadId.localeCompare(right.threadId),
        )
    );
  },
);

/**
 * The offset that would fetch the next page, or null once the end is reached.
 *
 * A page that lands exactly on the end still reports null rather than an offset
 * that would return nothing — the orchestrator reads a non-null value as "there
 * is more the user has not been told about", and an empty extra round-trip
 * reads to it as a real backlog.
 */
const nextOffsetFor = (offset: number, pageLength: number, total: number): number | null =>
  offset + pageLength < total ? offset + pageLength : null;

/**
 * Parse a `since`/`until` bound. Bare dates are accepted because the user talks
 * in days ("anything from today"), and an unparseable bound is an error rather
 * than a silently-ignored filter — quietly returning the whole backlog for a
 * request that asked for one day would be reported to the user as that day's.
 */
const parseTimeBound = (value: string | undefined, field: "since" | "until") =>
  Effect.gen(function* () {
    if (value === undefined) return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    // A bare date names a whole day, so which end of it we mean depends on which
    // bound it is: `since` starts at its first instant, `until` runs to its
    // last. Treating both as midnight would make `since` and `until` set to the
    // same day an empty window — and "everything from today" is the obvious way
    // to ask for one day, so that reads back as "nothing is waiting on you".
    const isBareDate = /^\d{4}-\d{2}-\d{2}$/u.test(trimmed);
    const normalized = isBareDate ? `${trimmed}T00:00:00.000Z` : trimmed;
    const parsed = DateTime.make(normalized).pipe(
      Option.map((instant) =>
        isBareDate && field === "until" ? DateTime.add(instant, { days: 1 }) : instant,
      ),
    );
    if (Option.isNone(parsed)) {
      return yield* new OrchestratorToolError({
        message: `\`${field}\` is not a date I can read: "${value}". Use an ISO 8601 timestamp or YYYY-MM-DD.`,
      });
    }
    // Normalized to UTC ISO so the bound can be compared lexicographically
    // against the stored timestamps, which are written the same way.
    return DateTime.formatIso(DateTime.toUtc(parsed.value));
  });

/** Inclusive on `since`, exclusive on `until`, so day ranges do not double-count. */
const withinBounds = (
  timestamp: string | null,
  bounds: { readonly since: string | null; readonly until: string | null },
): boolean => {
  if (bounds.since === null && bounds.until === null) return true;
  // An item with no timestamp cannot be shown to fall inside a window the user
  // asked for, and pending work is better over-reported than dropped.
  if (timestamp === null) return true;
  if (bounds.since !== null && timestamp < bounds.since) return false;
  return !(bounds.until !== null && timestamp >= bounds.until);
};

const matchesProject = (thread: ThreadSummary, projectTitle: string | undefined): boolean =>
  projectTitle === undefined ||
  projectTitle.trim().length === 0 ||
  thread.projectTitle.toLowerCase().includes(projectTitle.trim().toLowerCase());

/**
 * Resolve the single project a `projectTitle` fragment names.
 *
 * Ambiguity is an error rather than a best guess: a conversation started in the
 * wrong repository is not something the user can undo by reading the tool
 * result, and the orchestrator has the user right there to ask.
 */
const resolveTargetProject = Effect.fn("OrchestratorToolkit.resolveTargetProject")(function* (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  projectTitle: string,
) {
  const query = projectTitle.trim().toLowerCase();
  if (query.length === 0) {
    return yield* new OrchestratorToolError({ message: "Project title cannot be empty." });
  }

  const quote = (list: ReadonlyArray<OrchestrationProjectShell>) =>
    list.map((project) => `"${project.title}"`).join(", ");

  const matches = projects.filter((project) => project.title.toLowerCase().includes(query));
  if (matches.length === 0) {
    return yield* new OrchestratorToolError({
      message:
        projects.length === 0
          ? "There are no projects to create a conversation in."
          : `No project matching "${projectTitle}". Available projects: ${quote(projects)}.`,
    });
  }
  const first = matches[0];
  if (matches.length === 1 && first !== undefined) return first;

  // A fragment that is somebody's whole title wins over the substring hits it
  // also matched, so "api" still resolves when an "api-gateway" exists too.
  const exact = matches.filter((project) => project.title.toLowerCase() === query);
  const onlyExact = exact[0];
  if (exact.length === 1 && onlyExact !== undefined) return onlyExact;

  return yield* new OrchestratorToolError({
    message: `"${projectTitle}" matches ${matches.length} projects: ${quote(matches)}. Ask the user which one they mean.`,
  });
});

const handlers = {
  list_threads: (input) =>
    Effect.gen(function* () {
      const { invocation, orchestratorProjectId, accessFor, accessOverride } =
        yield* requireOrchestrator();
      const threads = yield* loadThreadSummaries({
        environmentId: invocation.environmentId,
        includeArchived: input.includeArchived === true,
        accessFor,
        orchestratorProjectId,
        callerThreadId: invocation.threadId,
      });
      const matched = threads
        .filter((thread) => matchesProject(thread, input.projectTitle))
        .filter((thread) => input.onlyNeedingAttention !== true || needsAttention(thread));

      const limit = input.limit ?? DEFAULT_THREAD_LIMIT;
      const offset = input.offset ?? 0;
      const page = matched.slice(offset, offset + limit);

      return {
        threads: page,
        totalMatched: matched.length,
        nextOffset: nextOffsetFor(offset, page.length, matched.length),
        accessMode: accessOverride,
      };
    }),

  search_threads: (input) =>
    Effect.gen(function* () {
      const { invocation, orchestratorProjectId, accessFor } = yield* requireOrchestrator();
      const conversationSearch = yield* ConversationSearch;
      const query = input.query.trim();
      if (query.length === 0) {
        return yield* new OrchestratorToolError({ message: "Search query cannot be empty." });
      }

      const result = yield* conversationSearch
        .search({
          query,
          limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
          ...(input.exact === undefined ? {} : { exact: input.exact }),
          ...(input.includeArchived === undefined
            ? {}
            : { includeArchived: input.includeArchived }),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorToolError({
                message: `Conversation search failed: ${cause.message}`,
              }),
          ),
        );

      return {
        // Search runs over every conversation, so closed threads are dropped
        // from the results rather than being excluded from the query. Its own
        // earlier conversations stay in — searching them is how a session finds
        // what a previous one already worked out — but never this one, which
        // would match its own words back to itself.
        results: result.results
          .filter((match) => match.threadId !== invocation.threadId)
          .filter(
            (match) =>
              match.projectId === orchestratorProjectId || accessFor(match.threadId) !== "none",
          )
          .map((match) => ({
            threadId: match.threadId,
            title: match.title,
            projectTitle: match.projectTitle,
            branch: match.branch,
            snippet: match.snippet,
            matchedRole: match.matchedRole,
            matchKind: match.matchKind,
            archived: match.archivedAt !== null,
            updatedAt: match.updatedAt,
          })),
        semanticStatus: result.semanticStatus,
      };
    }),

  read_thread: (input) =>
    Effect.gen(function* () {
      const { invocation, orchestratorProjectId, accessFor } = yield* requireOrchestrator();
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

      // The shell carries the derived pending/session flags used for the
      // summary below, and it is read before access is resolved: which project
      // the thread is in decides how that resolves.
      const shell = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.mapError(snapshotError("read the conversation's state")));

      // Its own earlier conversations are readable whatever the sharing
      // settings say — that is how a session picks up what the last one
      // decided, and they are the user's own meta conversations either way.
      // Itself is not: a thread summarising its own half-written turn back to
      // itself is a loop, not a memory.
      const isOrchestratorConversation =
        Option.isSome(shell) && shell.value.projectId === orchestratorProjectId;
      if (isOrchestratorConversation && input.threadId === invocation.threadId) {
        return yield* new OrchestratorToolError({
          message:
            "That is this conversation. Scroll back through it rather than reading it as though it were somebody else's.",
        });
      }
      const access = isOrchestratorConversation ? ("watch" as const) : accessFor(input.threadId);
      if (access === "none") {
        return yield* notShared(input.threadId);
      }

      if (Option.isNone(shell)) {
        // `list_threads`/`search_threads` can hand back archived threads, but
        // this query is deliberately active-only. Say which it is, so the
        // orchestrator can tell "archived" from "gone" and report accurately.
        const archived = yield* projectionSnapshotQuery
          .getArchivedShellSnapshot()
          .pipe(Effect.orElseSucceed(() => null));
        const isArchived =
          archived?.threads.some((thread) => thread.id === input.threadId) === true;
        return yield* new OrchestratorToolError({
          message: isArchived
            ? `"${input.threadId}" is archived. Archived conversations cannot be read or messaged; the user has to unarchive it first.`
            : `No conversation with id ${input.threadId}. It may have been deleted.`,
        });
      }
      const thread = shell.value;

      // Two narrow reads rather than the whole thread. The detail query returns
      // every message and every activity a conversation ever had — on a long one
      // that is megabytes of tool-call payloads, decoded, to show twelve
      // messages and derive a couple of pending questions.
      const [tailMessages, activities] = yield* Effect.all(
        [
          projectionSnapshotQuery.getThreadMessagesTail(
            input.threadId,
            input.messageLimit ?? DEFAULT_MESSAGE_LIMIT,
          ),
          projectionSnapshotQuery.listThreadActivitiesByKinds(
            input.threadId,
            ORCHESTRATOR_ACTIVITY_KINDS,
          ),
        ],
        { concurrency: 2 },
      ).pipe(Effect.mapError(snapshotError("read the conversation")));

      const project = yield* projectionSnapshotQuery
        .getProjectShellById(thread.projectId)
        .pipe(Effect.mapError(snapshotError("read the conversation's project")));
      const projectTitle = Option.match(project, {
        onNone: () => "Unknown project",
        onSome: (value: OrchestrationProjectShell) => value.title,
      });

      // Newest first while the budget is spent, so what survives a tight budget
      // is the end of the conversation rather than its opening — then flipped
      // back to reading order. Without this, asking for one message in full and
      // getting the oldest one instead would be the common case.
      const budget = { remaining: MAX_READ_THREAD_CHARS };
      const messages = tailMessages
        .toReversed()
        .filter(() => budget.remaining > 0)
        .map((message) => {
          const { text, truncated } = truncate(
            message.text,
            Math.min(input.messageChars ?? MAX_MESSAGE_CHARS, budget.remaining),
          );
          budget.remaining -= text.length;
          return {
            role: message.role,
            text,
            truncated,
            // A streaming message is the half-written tail of a turn still in
            // flight. Reporting it as the thread's last word would have the
            // orchestrator summarize an answer that is not finished.
            streaming: message.streaming,
            createdAt: message.createdAt,
          };
        })
        .toReversed();

      const recentlyResolvedFollowups = yield* summarizeResolvedFollowups(
        deriveResolvedFollowups(activities).slice(0, MAX_RESOLVED_FOLLOWUPS),
      ).pipe(
        Effect.mapError(snapshotError("read the conversations a follow-up was spun off into")),
      );

      return {
        thread: summarizeThread({
          access,
          environmentId: invocation.environmentId,
          thread,
          projectTitle,
          now: DateTime.toEpochMillis(yield* DateTime.now),
          isOrchestratorConversation,
        }),
        messages,
        pendingQuestions: toPendingQuestionSets(derivePendingUserInputs(activities), {
          threadId: thread.id,
          threadTitle: thread.title,
          projectTitle,
        }),
        pendingApprovals: toPendingApprovals(derivePendingApprovals(activities), {
          threadId: thread.id,
          threadTitle: thread.title,
          projectTitle,
        }),
        pendingFollowups: derivePendingFollowups(activities).map((followup) => ({
          ...followup,
          threadId: thread.id,
          threadTitle: thread.title,
          projectTitle,
        })),
        recentlyResolvedFollowups,
      };
    }),

  list_pending: (input) =>
    Effect.gen(function* () {
      const { invocation, orchestratorProjectId, accessFor } = yield* requireOrchestrator();
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

      const bounds = {
        since: yield* parseTimeBound(input.since, "since"),
        until: yield* parseTimeBound(input.until, "until"),
      };
      const limit = input.limit ?? DEFAULT_PENDING_LIMIT;
      const offset = input.offset ?? 0;
      const sections = new Set<PendingSection>(
        input.sections === undefined || input.sections.length === 0
          ? PENDING_SECTIONS
          : input.sections,
      );
      const page = <T>(items: ReadonlyArray<T>): Array<T> => items.slice(offset, offset + limit);

      const threads = (yield* loadThreadSummaries({
        environmentId: invocation.environmentId,
        includeArchived: false,
        accessFor,
        orchestratorProjectId,
        callerThreadId: invocation.threadId,
      })).filter((thread) => matchesProject(thread, input.projectTitle));

      // A thread is in range on when it last moved. The three thread-shaped
      // sections have nothing finer to filter on, so this is where the bound
      // lands for them.
      const inRange = threads.filter((thread) => withinBounds(thread.updatedAt, bounds));

      // Gathered whichever sections were asked for, because their counts are
      // reported as true totals and filtering an already-loaded array is free.
      // Narrowing `sections` suppresses the item lists, not the tally — a caller
      // working through follow-ups should still be told six threads are stuck on
      // a question rather than being shown a zero it would read as "none".
      const awaitingApproval = inRange.filter((thread) => thread.awaitingApproval);
      const awaitingUserInput = inRange.filter((thread) => thread.awaitingUserInput);
      const failed = inRange.filter((thread) => thread.phase === "failed");

      // Questions are hydrated only for the page of threads actually being
      // returned, rather than for every waiting thread — at library scale the
      // difference is the whole point of paging, since `getThreadDetailById` is
      // several queries deep and returning the questions for threads the caller
      // was not shown would put the cap back where it started.
      const questionThreads = sections.has("questions") ? page(awaitingUserInput) : [];
      // Same reasoning for approvals: hydrate the page being returned, not
      // every blocked thread in the library.
      const approvalThreads = sections.has("approvals") ? page(awaitingApproval) : [];

      // Follow-ups carry their own timestamp, so they are filtered on when the
      // follow-up was recorded rather than on when its thread last moved —
      // deliberately searching the whole thread list, not `inRange`. A month-old
      // follow-up sitting in a thread someone touched this morning is precisely
      // what "the oldest thing I have forgotten" means, and filtering its thread
      // out by `updatedAt` would hide it from the query asking for it.
      //
      // They also have to be counted across every holder before they can be
      // paged: the count is what the user is told, and unlike the thread
      // sections there is no precomputed total to read it off. Only threads
      // flagged as holding one get hydrated, so this stays proportional to the
      // backlog rather than to the library.
      const followupThreads = sections.has("followups")
        ? threads.filter((thread) => thread.hasPendingFollowups)
        : [];

      const hydrateThreads = [
        ...new Map(
          [...questionThreads, ...approvalThreads, ...followupThreads].map((thread) => [
            thread.threadId,
            thread,
          ]),
        ).values(),
      ];
      const questionThreadIds = new Set(questionThreads.map((thread) => thread.threadId));
      const approvalThreadIds = new Set(approvalThreads.map((thread) => thread.threadId));
      const followupThreadIds = new Set(followupThreads.map((thread) => thread.threadId));

      const hydrated = yield* Effect.forEach(
        hydrateThreads,
        (thread) =>
          // Only the activity kinds these two derivations read. Loading the
          // whole thread detail here meant pulling every tool call and step
          // payload in the conversation to look at a handful of rows.
          projectionSnapshotQuery
            .listThreadActivitiesByKinds(thread.threadId, ORCHESTRATOR_ACTIVITY_KINDS)
            .pipe(
              Effect.map((activities) => ({
                followups: followupThreadIds.has(thread.threadId)
                  ? derivePendingFollowups(activities)
                      .filter((followup) => withinBounds(followup.createdAt, bounds))
                      .map((followup) => ({
                        ...followup,
                        threadId: thread.threadId,
                        threadTitle: thread.title,
                        projectTitle: thread.projectTitle,
                      }))
                  : [],
                questions: questionThreadIds.has(thread.threadId)
                  ? toPendingQuestionSets(derivePendingUserInputs(activities), {
                      threadId: thread.threadId,
                      threadTitle: thread.title,
                      projectTitle: thread.projectTitle,
                    })
                  : [],
                approvals: approvalThreadIds.has(thread.threadId)
                  ? toPendingApprovals(derivePendingApprovals(activities), {
                      threadId: thread.threadId,
                      threadTitle: thread.title,
                      projectTitle: thread.projectTitle,
                    })
                  : [],
              })),
              // A thread that will not load contributes nothing rather than
              // failing the whole call, but it is logged: its follow-ups are
              // silently missing from a count the orchestrator presents to the
              // user as the complete backlog.
              Effect.tapCause((cause) =>
                Effect.logWarning("Could not read a pending thread; its items are missing", {
                  threadId: thread.threadId,
                  cause,
                }),
              ),
              Effect.orElseSucceed(() => ({ followups: [], questions: [], approvals: [] })),
            ),
        { concurrency: 4 },
      );

      // Oldest first: a follow-up nobody has cleared in weeks is the one most
      // likely to have been forgotten, so it is what the first page should show.
      const pendingFollowups = hydrated
        .flatMap((entry) => entry.followups)
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));

      const counts = {
        awaitingApproval: awaitingApproval.length,
        awaitingUserInput: awaitingUserInput.length,
        failed: failed.length,
        // Null rather than zero when the section was not requested: follow-ups
        // are the one total that cannot be read off the thread list, so leaving
        // it out is honest where a zero would be a lie.
        pendingFollowups: sections.has("followups") ? pendingFollowups.length : null,
      };
      const sectionPages = [
        [sections.has("approvals") ? awaitingApproval : [], page(awaitingApproval)],
        [sections.has("questions") ? awaitingUserInput : [], questionThreads],
        [sections.has("failed") ? failed : [], page(failed)],
        [pendingFollowups, page(pendingFollowups)],
      ] as const;

      return {
        awaitingApproval: sections.has("approvals") ? page(awaitingApproval) : [],
        awaitingUserInput: questionThreads,
        pendingQuestions: hydrated.flatMap((entry) => entry.questions),
        pendingApprovalRequests: hydrated.flatMap((entry) => entry.approvals),
        failed: sections.has("failed") ? page(failed) : [],
        pendingFollowups: page(pendingFollowups),
        counts,
        // The furthest any section still has to go, so a single follow-up call
        // picks up whatever was left out of any of them.
        nextOffset: sectionPages.reduce<number | null>((furthest, [all, shown]) => {
          const next = nextOffsetFor(offset, shown.length, all.length);
          return next === null ? furthest : Math.max(furthest ?? next, next);
        }, null),
        sections: PENDING_SECTIONS.filter((section) => sections.has(section)),
      };
    }),

  send_to_thread: (input) =>
    Effect.gen(function* () {
      const { invocation, orchestratorProjectId, accessFor, accessOverride } =
        yield* requireOrchestrator();
      const access = accessFor(input.threadId);
      if (access === "none") {
        return yield* notShared(input.threadId);
      }
      if (access !== "control") {
        return yield* new OrchestratorToolError({
          message: `You may read conversation ${input.threadId} but not send to it. Tell the user what you would send. ${raiseToControlHint(accessOverride)}`,
        });
      }
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const startup = yield* ServerRuntimeStartup;
      const crypto = yield* Crypto.Crypto;

      const message = input.message.trim();
      if (message.length === 0) {
        return yield* new OrchestratorToolError({ message: "Message cannot be empty." });
      }

      if (input.threadId === invocation.threadId) {
        return yield* new OrchestratorToolError({
          message: "Refusing to send to this conversation's own thread.",
        });
      }

      const shell = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.mapError(snapshotError("read the target conversation")));
      if (Option.isNone(shell)) {
        return yield* new OrchestratorToolError({
          message: `No active conversation with id ${input.threadId}. It may have been archived or deleted.`,
        });
      }
      const target = shell.value;

      const project = yield* projectionSnapshotQuery
        .getProjectShellById(target.projectId)
        .pipe(Effect.mapError(snapshotError("read the target conversation's project")));
      const projectTitle = Option.match(project, {
        onNone: () => "Unknown project",
        onSome: (value: OrchestrationProjectShell) => value.title,
      });

      // Every thread in the orchestrator project holds the capability, so
      // without this two meta conversations could drive each other turn after
      // turn with nothing to stop them.
      if (target.projectId === orchestratorProjectId) {
        return yield* new OrchestratorToolError({
          message: `"${target.title}" is another orchestrator conversation. Orchestrators relay work to the threads that do it, never to each other.`,
        });
      }

      const summary = summarizeThread({
        access,
        environmentId: invocation.environmentId,
        thread: target,
        projectTitle,
        now: DateTime.toEpochMillis(yield* DateTime.now),
        // Sibling orchestrator threads were refused above.
        isOrchestratorConversation: false,
      });

      // A parked thread is waiting on the user, not on more instructions.
      // Answering the prompt is the only thing that unblocks it, and the
      // composer refuses this too. A question you can answer from here; an
      // approval you cannot, and the user has to go to the thread.
      if (summary.awaitingApproval || summary.awaitingUserInput) {
        return yield* new OrchestratorToolError({
          message: summary.awaitingUserInput
            ? `"${target.title}" is blocked: ${summary.headline.toLowerCase()}. Sending now would not unblock it — read the question with read_thread, put it to the user, and answer it with answer_thread_question.`
            : `"${target.title}" is blocked: ${summary.headline.toLowerCase()}. Tell the user to answer it there first — sending now would not unblock it.`,
        });
      }

      // Steering appends to the running turn rather than aborting it — the
      // provider queues the message into the live agent loop and the work
      // continues as the same turn (a real abort is `thread.turn.interrupt`,
      // which this tool does not do). Still gated: redirecting an agent
      // mid-task is the user's call, not something to do by accident.
      if (summary.hasActiveTurn && input.steerRunningTurn !== true) {
        return yield* new OrchestratorToolError({
          message: `"${target.title}" is mid-turn. Sending now would append your message to the turn already running — it keeps its work, but reads this while going and may change course. Tell the user that, and re-send with steerRunningTurn:true if they want it redirected now rather than waiting for the turn to finish.`,
        });
      }

      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const commandUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const messageUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);

      yield* startup
        .enqueueCommand(
          orchestrationEngine.dispatch({
            type: "thread.turn.start",
            // Prefixed so the event log shows at a glance that this turn was
            // relayed by an orchestrator rather than typed by the user.
            commandId: CommandId.make(`orchestrator:${commandUuid}`),
            threadId: input.threadId,
            message: {
              messageId: MessageId.make(messageUuid),
              role: "user",
              text: message,
              attachments: [],
            },
            // Inherit the target thread's own configuration: the point of
            // sending here rather than starting fresh is that its worktree,
            // branch, model and permissions already fit the work.
            modelSelection: target.modelSelection,
            runtimeMode: target.runtimeMode,
            interactionMode: target.interactionMode,
            createdAt,
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorToolError({
                message: `Failed to send to "${target.title}": ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
              }),
          ),
        );

      return {
        threadId: target.id,
        threadTitle: target.title,
        projectTitle,
        steeredRunningTurn: summary.hasActiveTurn,
      };
    }),

  create_thread: (input) =>
    Effect.gen(function* () {
      const { invocation, orchestratorProjectId } = yield* requireOrchestrator();
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const serverSettings = yield* ServerSettingsService;
      const startup = yield* ServerRuntimeStartup;
      const crypto = yield* Crypto.Crypto;

      const title = input.title.trim();
      const message = input.message.trim();
      if (title.length === 0) {
        return yield* new OrchestratorToolError({ message: "Title cannot be empty." });
      }
      if (message.length === 0) {
        return yield* new OrchestratorToolError({
          message:
            "Opening message cannot be empty. A conversation with no prompt would sit there doing nothing.",
        });
      }

      const shell = yield* projectionSnapshotQuery
        .getShellSnapshot()
        .pipe(Effect.mapError(snapshotError("read the project list")));
      // The orchestrator's own project is not a place to put work: threads
      // there hold the cross-thread tools, so this would be spawning another
      // orchestrator rather than something that writes code.
      const projects = shell.projects.filter((project) => project.id !== orchestratorProjectId);
      const project = yield* resolveTargetProject(projects, input.projectTitle);

      // A project without a default model has never pinned one, so fall back to
      // whatever this orchestrator conversation is itself running — a known-good
      // selection on a provider that exists, rather than a guess.
      const callerThread = yield* projectionSnapshotQuery
        .getThreadShellById(invocation.threadId)
        .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThreadShell>()));
      const inheritedModel =
        project.defaultModelSelection ??
        (Option.isSome(callerThread) ? callerThread.value.modelSelection : null);

      // Choosing a model is allow-listed: the defaults cover the current
      // primary Claude and Codex models, and the user can curate or clear the
      // set in settings. Anything outside it is refused rather than guessed.
      const allowedModels = yield* serverSettings.getSettings.pipe(
        Effect.map((value) => value.orchestratorModelChoices),
        Effect.orElseSucceed(() => [] as ReadonlyArray<ModelSelection>),
      );
      const requestedModel = input.model?.trim();
      let modelSelection: ModelSelection | null = inheritedModel;
      if (requestedModel !== undefined && requestedModel.length > 0) {
        const allowedList =
          allowedModels.length === 0
            ? "none — the user has not sanctioned any models for you to choose from, so omit `model` and let the conversation inherit its project's default"
            : allowedModels.map((choice) => `"${choice.model}"`).join(", ");
        const match = allowedModels.find(
          (choice) => choice.model.toLowerCase() === requestedModel.toLowerCase(),
        );
        if (match === undefined) {
          return yield* new OrchestratorToolError({
            message: `"${requestedModel}" is not a model you may choose. Allowed: ${allowedList}. Pick one of those or omit \`model\`; do not ask the user to widen the list unless they raise it. If they do, it lives under Settings > Orchestrator > Orchestrator model choices.`,
          });
        }
        modelSelection = match;
      }

      if (modelSelection === null) {
        return yield* new OrchestratorToolError({
          message: `"${project.title}" has no default model and none could be inferred. Ask the user to pick a model for that project first.`,
        });
      }

      // Deliberately not `DEFAULT_RUNTIME_MODE`. That default is for a thread
      // the user just typed into and is sitting in front of; this one was
      // opened by an agent and may run with nobody watching, so it starts
      // supervised unless the caller asked for something looser.
      const runtimeMode = input.runtimeMode ?? "approval-required";
      const access = input.access ?? "control";
      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const threadId = ThreadId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      const createUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const turnUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const messageUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);

      const dispatchFailed = (action: string) => (cause: unknown) =>
        new OrchestratorToolError({
          message: `Failed to ${action}: ${cause instanceof Error ? cause.message : String(cause)}`,
        });

      yield* startup
        .enqueueCommand(
          orchestrationEngine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`orchestrator:${createUuid}`),
            threadId,
            projectId: project.id,
            title,
            modelSelection,
            runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt,
          }),
        )
        .pipe(Effect.mapError(dispatchFailed(`create a conversation in "${project.title}"`)));

      // Leaving an empty, never-started thread behind would show up in the
      // sidebar as a conversation the user did not open and cannot explain.
      const deleteCreatedThread = crypto.randomUUIDv4.pipe(
        Effect.orDie,
        Effect.flatMap((uuid) =>
          orchestrationEngine.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`orchestrator:${uuid}`),
            threadId,
          }),
        ),
        Effect.ignoreCause({ log: true }),
      );

      // A worktree conversation gets its own branch and checkout so two tracks
      // in one repository cannot edit the same files underneath each other.
      // Mirrors the bootstrap path in ws.ts, minus the interactive parts: git
      // failures abort the whole thing and take the thread with them, because
      // an orchestrator-opened conversation has nobody sitting in front of it
      // to resolve a half-prepared workspace.
      let branch: string | null = null;
      let worktreePath: string | null = null;
      let setupScript: string | null = null;

      if (input.envMode === "worktree") {
        const gitWorkflow = yield* GitWorkflowService;
        const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;

        // Two distinct failures, and they leave the disk in different states —
        // saying "nothing was created" after the worktree already exists would
        // send the user looking for a checkout they have been told is not there.
        const worktreeFailed = (cause: unknown) =>
          new OrchestratorToolError({
            message: `Could not give "${title}" its own worktree in "${project.title}": ${
              cause instanceof Error ? cause.message : String(cause)
            }. Nothing was created. Tell the user — this usually means the project is not a git repository, or its checkout is in a state git will not branch from.`,
          });
        const afterWorktreeFailed = (worktreeRef: string) => (cause: unknown) =>
          new OrchestratorToolError({
            message: `Gave "${title}" a worktree in "${project.title}" but could not finish setting the conversation up: ${
              cause instanceof Error ? cause.message : String(cause)
            }. The conversation was discarded; the worktree and its branch "${worktreeRef}" are still on disk and nobody is using them. Tell the user so they can remove it or reuse it.`,
          });

        // `buildTemporaryWorktreeBranchName` wants a hex source; a v4 uuid with
        // its dashes removed is one, and is the randomness this handler already
        // has to hand.
        const branchUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const randomHex = (byteLength: number) =>
          branchUuid.replaceAll("-", "").slice(0, byteLength * 2);

        const prepared = yield* Effect.gen(function* () {
          // Branch from wherever the project currently sits, the same base the
          // composer offers by default.
          const status = yield* gitWorkflow
            .localStatus({ cwd: project.workspaceRoot })
            .pipe(Effect.mapError(worktreeFailed));
          const baseBranch = status.isRepo ? status.refName : null;
          if (baseBranch === null || baseBranch.trim().length === 0) {
            return yield* new OrchestratorToolError({
              message: `"${project.title}" has no current branch to base a worktree on (detached HEAD, or not a git repository). Nothing was created. Start this conversation with envMode:'local' instead, or ask the user to check out a branch.`,
            });
          }

          const worktree = yield* gitWorkflow
            .createWorktree({
              cwd: project.workspaceRoot,
              refName: baseBranch,
              // A generated name, so the new conversation never tries to check
              // out a branch another worktree already holds — git refuses that.
              newRefName: buildTemporaryWorktreeBranchName(randomHex),
              path: null,
            })
            .pipe(Effect.mapError(worktreeFailed));

          yield* orchestrationEngine
            .dispatch({
              type: "thread.meta.update",
              commandId: CommandId.make(
                `orchestrator:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
              ),
              threadId,
              branch: worktree.worktree.refName,
              worktreePath: worktree.worktree.path,
            })
            .pipe(Effect.mapError(afterWorktreeFailed(worktree.worktree.refName)));

          return worktree.worktree;
        }).pipe(
          // Same interrupt carve-out as the turn start below: cancelling the
          // caller must not race a cleanup against work already queued.
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : deleteCreatedThread,
          ),
        );

        branch = prepared.refName;
        worktreePath = prepared.path;

        // A fresh worktree has no node_modules. Failing to install is not worth
        // discarding the conversation over — the agent can still read code and
        // the user can fix it — but the orchestrator must be told, or it will
        // report a broken workspace as ready.
        setupScript = yield* projectSetupScriptRunner
          .runForThread({
            threadId,
            projectId: project.id,
            projectCwd: project.workspaceRoot,
            worktreePath: prepared.path,
          })
          .pipe(
            Effect.map((result): string => result.status),
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestrator create_thread could not start the setup script", {
                threadId,
                worktreePath: prepared.path,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as("failed" as string)),
            ),
          );
      }

      yield* startup
        .enqueueCommand(
          orchestrationEngine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`orchestrator:${turnUuid}`),
            threadId,
            message: {
              messageId: MessageId.make(messageUuid),
              role: "user",
              text: message,
              attachments: [],
            },
            modelSelection,
            // No `titleSeed`: that opts the thread into having its title
            // replaced by a provider-generated one, which is right for the
            // composer's throwaway truncation of the prompt but not for a title
            // the orchestrator chose deliberately and just reported back.
            runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          }),
        )
        .pipe(
          Effect.mapError(dispatchFailed(`start the new conversation in "${project.title}"`)),
          Effect.tapCause((cause) =>
            // Interruption is not failure: `enqueueCommand` hands the dispatch
            // to a queue, so cancelling the fiber waiting on it does not
            // un-queue the turn. Deleting here would destroy a thread that goes
            // on to start anyway. Same reasoning as the bootstrap path in ws.ts.
            Cause.hasInterruptsOnly(cause) ? Effect.void : deleteCreatedThread,
          ),
        );

      // Recorded explicitly rather than left to the default, so the orchestrator
      // keeps what it opened even when the baseline is "none". Written as a
      // single entry: a whole-map write would carry a snapshot read before the
      // turn started and could restore access the user revoked while it ran.
      yield* serverSettings
        .updateSettings({
          orchestratorThreadAccessEntry: { threadId, access },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorToolError({
                message: `"${title}" was created in "${project.title}" and has started, but recording your access to it failed: ${cause.message}. Tell the user, and ask them to share it from that conversation's composer if you need to follow up.`,
              }),
          ),
        );

      return {
        threadId,
        threadTitle: title,
        projectTitle: project.title,
        model: modelSelection.model,
        runtimeMode,
        branch,
        worktreePath,
        setupScript,
        orchestratorAccess: access,
      };
    }),

  read_thread_changes: (input) =>
    Effect.gen(function* () {
      const { orchestratorProjectId, accessFor } = yield* requireOrchestrator();
      if (accessFor(input.threadId) === "none") {
        return yield* notShared(input.threadId);
      }

      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      // The shell for the thread's own fields, the checkpoint context for its
      // capture history. Reading the full detail here pulled every message and
      // every activity payload in the conversation to look at the checkpoints.
      const [shell, checkpointContext] = yield* Effect.all(
        [
          projectionSnapshotQuery.getThreadShellById(input.threadId),
          projectionSnapshotQuery.getThreadCheckpointContext(input.threadId),
        ],
        { concurrency: 2 },
      ).pipe(Effect.mapError(snapshotError("read the conversation")));
      if (Option.isNone(shell)) {
        return yield* new OrchestratorToolError({
          message: `No active conversation with id ${input.threadId}. It may have been archived or deleted.`,
        });
      }
      const thread = shell.value;
      if (thread.projectId === orchestratorProjectId) {
        return yield* new OrchestratorToolError({
          message: `"${thread.title}" is another orchestrator conversation. Orchestrators do not write code, so there is nothing to review here.`,
        });
      }

      const project = yield* projectionSnapshotQuery
        .getProjectShellById(thread.projectId)
        .pipe(Effect.mapError(snapshotError("read the conversation's project")));
      const projectTitle = Option.match(project, {
        onNone: () => "Unknown project",
        onSome: (value: OrchestrationProjectShell) => value.title,
      });

      // Checkpoints already carry the per-file stats the reactor computed when
      // each turn ended, so the summary costs a single read rather than shelling
      // out to git. Only "ready" ones have trustworthy numbers.
      const checkpoints = (
        Option.isSome(checkpointContext) ? checkpointContext.value.checkpoints : []
      )
        .filter((checkpoint) => checkpoint.status === "ready")
        .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount);

      // Named for what they are. An agent reading `additions` will quote it as
      // the size of the change; `churnAdditions` it has to think about.
      const totals = new Map<string, { churnAdditions: number; churnDeletions: number }>();
      for (const checkpoint of checkpoints) {
        for (const file of checkpoint.files) {
          const current = totals.get(file.path) ?? { churnAdditions: 0, churnDeletions: 0 };
          totals.set(file.path, {
            churnAdditions: current.churnAdditions + file.additions,
            churnDeletions: current.churnDeletions + file.deletions,
          });
        }
      }

      const rankedFiles = [...totals.entries()]
        .map(([path, counts]) => ({ path, ...counts }))
        .toSorted(
          (left, right) =>
            right.churnAdditions +
              right.churnDeletions -
              (left.churnAdditions + left.churnDeletions) || left.path.localeCompare(right.path),
        );
      const files = rankedFiles.slice(0, MAX_CHANGED_FILES);

      // A checkpoint is a snapshot of the whole checkout, not of this thread's
      // edits — nothing records which file a given agent touched. In a worktree
      // that is nearly the same thing, since the thread is usually alone there.
      // In the project checkout it is not: every conversation in the project,
      // and the user's own editor, writes to the same tree, so these numbers are
      // "what changed here while the thread ran". Saying so is the difference
      // between evidence and a confident guess.
      const otherLiveThreads =
        thread.worktreePath === null
          ? yield* projectionSnapshotQuery.getShellSnapshot().pipe(
              Effect.map(
                (snapshot) =>
                  snapshot.threads.filter(
                    (candidate) =>
                      candidate.projectId === thread.projectId &&
                      candidate.id !== thread.id &&
                      candidate.worktreePath === null &&
                      candidate.archivedAt === null,
                  ).length,
              ),
              Effect.orElseSucceed(() => 0),
            )
          : 0;

      const turns = checkpoints.map((checkpoint) => ({
        turnCount: checkpoint.checkpointTurnCount,
        fileCount: checkpoint.files.length,
        additions: checkpoint.files.reduce((sum, file) => sum + file.additions, 0),
        deletions: checkpoint.files.reduce((sum, file) => sum + file.deletions, 0),
        completedAt: checkpoint.completedAt,
      }));

      let patch: string | null = null;
      let patchTruncated = false;
      if (input.includePatch === true) {
        const latestTurnCount = checkpoints.at(-1)?.checkpointTurnCount ?? 0;
        const requested = input.turnCount;
        if (
          requested !== undefined &&
          !checkpoints.some((c) => c.checkpointTurnCount === requested)
        ) {
          return yield* new OrchestratorToolError({
            message: `"${thread.title}" has no checkpoint for turn ${requested}. Its turns are: ${
              turns.length === 0
                ? "none yet — nothing has been committed to a checkpoint"
                : turns.map((turn) => turn.turnCount).join(", ")
            }.`,
          });
        }
        if (latestTurnCount > 0) {
          const checkpointDiffQuery = yield* CheckpointDiffQuery;
          // One turn diffs from the turn before it; otherwise diff the whole
          // conversation from its starting point.
          const raw = yield* (
            requested === undefined
              ? checkpointDiffQuery.getFullThreadDiff({
                  threadId: input.threadId,
                  toTurnCount: latestTurnCount,
                })
              : checkpointDiffQuery.getTurnDiff({
                  threadId: input.threadId,
                  fromTurnCount: requested - 1,
                  toTurnCount: requested,
                })
          ).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorToolError({
                  message: `Failed to read the diff for "${thread.title}": ${cause.message}`,
                }),
            ),
          );
          // The checkpoint driver caps at 10MB, which is a safety limit rather
          // than a context budget. Cut it to something an agent can actually
          // read, and say so, so a truncated patch is never mistaken for the
          // whole change.
          if (raw.diff.length > MAX_PATCH_CHARS) {
            patch = `${raw.diff.slice(0, MAX_PATCH_CHARS)}\n\n[truncated — ask for a single turn with turnCount, or open the conversation]`;
            patchTruncated = true;
          } else {
            patch = raw.diff;
          }
        }
      }

      return {
        threadId: thread.id,
        threadTitle: thread.title,
        projectTitle,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        files,
        totalChurnAdditions: rankedFiles.reduce((sum, file) => sum + file.churnAdditions, 0),
        totalChurnDeletions: rankedFiles.reduce((sum, file) => sum + file.churnDeletions, 0),
        turns,
        patch,
        truncated: patchTruncated || rankedFiles.length > files.length,
        sharedCheckout: thread.worktreePath === null,
        otherThreadsInCheckout: otherLiveThreads,
        attribution:
          thread.worktreePath === null
            ? otherLiveThreads > 0
              ? `Not attributable to this conversation. It works in the project checkout, which ${otherLiveThreads} other active conversation${otherLiveThreads === 1 ? "" : "s"} share, so these are all the changes made there while it ran — including work that is not its own, and any edits the user made themselves. Treat it as an upper bound and confirm before crediting anything to this thread.`
              : "Works in the project checkout rather than its own worktree. No other active conversation shares it right now, but anything the user changed by hand is counted here too."
            : "Has its own worktree, so these changes are almost certainly its own — barring anything the user edited there directly.",
      };
    }),

  answer_thread_question: (input) =>
    Effect.gen(function* () {
      const { orchestratorProjectId, accessFor, accessOverride } = yield* requireOrchestrator();
      const access = accessFor(input.threadId);
      if (access === "none") {
        return yield* notShared(input.threadId);
      }
      // Answering resumes the thread's turn, which is at least as consequential
      // as sending it a message — so it takes the same permission.
      if (access !== "control") {
        return yield* new OrchestratorToolError({
          message: `You may read conversation ${input.threadId}'s question but not answer it. Tell the user what it is asking, so they can answer it there. ${raiseToControlHint(accessOverride)}`,
        });
      }

      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const startup = yield* ServerRuntimeStartup;
      const crypto = yield* Crypto.Crypto;

      const detail = yield* projectionSnapshotQuery
        .getThreadDetailById(input.threadId)
        .pipe(Effect.mapError(snapshotError("read the conversation")));
      if (Option.isNone(detail)) {
        return yield* new OrchestratorToolError({
          message: `No active conversation with id ${input.threadId}. It may have been archived or deleted.`,
        });
      }
      const thread: OrchestrationThread = detail.value;
      if (thread.projectId === orchestratorProjectId) {
        return yield* new OrchestratorToolError({
          message: `"${thread.title}" is another orchestrator conversation. Orchestrators do not answer each other's questions; ask the user instead.`,
        });
      }

      const project = yield* projectionSnapshotQuery
        .getProjectShellById(thread.projectId)
        .pipe(Effect.mapError(snapshotError("read the conversation's project")));
      const projectTitle = Option.match(project, {
        onNone: () => "Unknown project",
        onSome: (value: OrchestrationProjectShell) => value.title,
      });

      const pending = derivePendingUserInputs(thread.activities);
      if (pending.length === 0) {
        return yield* new OrchestratorToolError({
          message: `"${thread.title}" is not waiting on a question — either it was already answered or the request expired. Re-read the thread before telling the user anything about it.`,
        });
      }

      // Answering the wrong request would resume the thread on a question the
      // user never saw, so an ambiguous call is refused rather than guessed.
      const request =
        input.requestId === undefined
          ? pending.length === 1
            ? pending[0]
            : undefined
          : pending.find((candidate) => candidate.requestId === input.requestId);
      if (request === undefined) {
        const open = pending
          .map((candidate) => `${candidate.requestId} ("${candidate.questions[0]?.header ?? "?"}")`)
          .join(", ");
        return yield* new OrchestratorToolError({
          message:
            input.requestId === undefined
              ? `"${thread.title}" has ${pending.length} unanswered questions; pass the requestId of the one you mean. Open requests: ${open}.`
              : `No unanswered question with requestId ${input.requestId} in "${thread.title}" — it may have just been answered in the thread. Open requests: ${open}.`,
        });
      }

      // The provider looks answers up by question id, and a partial map leaves
      // it waiting, so the whole set has to be resolved before anything is
      // dispatched.
      const answers: Record<string, string | ReadonlyArray<string>> = {};
      const answered: Array<{
        questionId: string;
        selectedOptions: ReadonlyArray<string>;
        customAnswer: string | null;
      }> = [];

      const known = new Set(request.questions.map((question) => question.id));
      const unknown = input.answers
        .map((answer) => answer.questionId)
        .filter((questionId) => !known.has(questionId));
      if (unknown.length > 0) {
        return yield* new OrchestratorToolError({
          message: `Unrecognized questionId(s) ${unknown.join(", ")}. This request's questions are: ${[
            ...known,
          ]
            .map((questionId) => `"${questionId}"`)
            .join(", ")}. Copy them back verbatim from read_thread or list_pending.`,
        });
      }

      for (const question of request.questions) {
        const supplied = input.answers.find((answer) => answer.questionId === question.id);
        if (supplied === undefined) {
          return yield* new OrchestratorToolError({
            message: `No answer given for "${question.id}". Every question in the request has to be answered in one call — this one has ${request.questions.length}.`,
          });
        }

        const customAnswer = supplied.customAnswer?.trim() ?? "";
        if (customAnswer.length > 0) {
          answers[question.id] = customAnswer;
          answered.push({ questionId: question.id, selectedOptions: [], customAnswer });
          continue;
        }

        // Labels are matched case-insensitively but sent back in the question's
        // own casing: the receiving agent matches on the label it wrote.
        const selected: string[] = [];
        for (const raw of supplied.selectedOptions ?? []) {
          const label = raw.trim();
          if (label.length === 0) continue;
          const option = question.options.find(
            (candidate) => candidate.label.toLowerCase() === label.toLowerCase(),
          );
          if (option === undefined) {
            return yield* new OrchestratorToolError({
              message: `"${label}" is not one of the options for "${question.id}". Its options are: ${question.options
                .map((candidate) => `"${candidate.label}"`)
                .join(
                  ", ",
                )}. Pass one of those verbatim, or put the user's own wording in customAnswer.`,
            });
          }
          if (!selected.includes(option.label)) {
            selected.push(option.label);
          }
        }

        if (selected.length === 0) {
          return yield* new OrchestratorToolError({
            message: `No answer given for "${question.id}": pass a selectedOptions label or a customAnswer. Its options are: ${question.options
              .map((candidate) => `"${candidate.label}"`)
              .join(", ")}.`,
          });
        }
        if (!question.multiSelect && selected.length > 1) {
          return yield* new OrchestratorToolError({
            message: `"${question.id}" takes a single option, but ${selected.length} were given (${selected.join(", ")}). Pick one, or say what the user actually wants in customAnswer.`,
          });
        }

        answers[question.id] = question.multiSelect ? selected : selected[0]!;
        answered.push({ questionId: question.id, selectedOptions: selected, customAnswer: null });
      }

      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const commandUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);

      yield* startup
        .enqueueCommand(
          orchestrationEngine.dispatch({
            type: "thread.user-input.respond",
            // Prefixed so the event log shows the answer came from an
            // orchestrator rather than from the composer.
            commandId: CommandId.make(`orchestrator:${commandUuid}`),
            threadId: input.threadId,
            requestId: request.requestId,
            answers,
            createdAt,
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorToolError({
                message: `Failed to answer "${thread.title}": ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
              }),
          ),
        );

      return {
        threadId: input.threadId,
        threadTitle: thread.title,
        projectTitle,
        requestId: request.requestId,
        answered,
      };
    }),

  respond_to_approval: (input) =>
    Effect.gen(function* () {
      const { orchestratorProjectId, accessFor, accessOverride } = yield* requireOrchestrator();
      const access = accessFor(input.threadId);
      if (access === "none") {
        return yield* notShared(input.threadId);
      }
      // Approving resumes the thread and runs whatever it asked to run, which
      // is the most consequential thing on this surface — so it takes the same
      // permission as sending, and refuses on "watch" rather than degrading.
      if (access !== "control") {
        return yield* new OrchestratorToolError({
          message: `You may see what conversation ${input.threadId} is waiting to do, but not allow it. Tell the user what it is asking for so they can answer it there. ${raiseToControlHint(accessOverride)}`,
        });
      }

      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const startup = yield* ServerRuntimeStartup;
      const crypto = yield* Crypto.Crypto;

      const shell = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.mapError(snapshotError("read the conversation")));
      if (Option.isNone(shell)) {
        return yield* new OrchestratorToolError({
          message: `No active conversation with id ${input.threadId}. It may have been archived or deleted.`,
        });
      }
      const thread = shell.value;
      if (thread.projectId === orchestratorProjectId) {
        return yield* new OrchestratorToolError({
          message: `"${thread.title}" is another orchestrator conversation. Orchestrators do not run commands, so there is nothing here to approve.`,
        });
      }

      const project = yield* projectionSnapshotQuery
        .getProjectShellById(thread.projectId)
        .pipe(Effect.mapError(snapshotError("read the conversation's project")));
      const projectTitle = Option.match(project, {
        onNone: () => "Unknown project",
        onSome: (value: OrchestrationProjectShell) => value.title,
      });

      const activities = yield* projectionSnapshotQuery
        .listThreadActivitiesByKinds(input.threadId, ORCHESTRATOR_ACTIVITY_KINDS)
        .pipe(Effect.mapError(snapshotError("read the conversation's approval requests")));
      const pending = derivePendingApprovals(activities);
      if (pending.length === 0) {
        return yield* new OrchestratorToolError({
          message: `"${thread.title}" is not waiting on an approval — either it was already answered or the request expired. Re-read the thread before telling the user anything about it.`,
        });
      }

      // Answering the wrong request would run a command the user never saw, so
      // an ambiguous call is refused rather than guessed. Same contract as
      // answer_thread_question, and for a rather larger reason.
      const request =
        input.requestId === undefined
          ? pending.length === 1
            ? pending[0]
            : undefined
          : pending.find((candidate) => candidate.requestId === input.requestId);
      if (request === undefined) {
        const open = pending
          .map(
            (candidate) =>
              `${candidate.requestId} (${candidate.requestKind ?? "approval"}: ${
                candidate.detail ?? "no detail"
              })`,
          )
          .join(", ");
        return yield* new OrchestratorToolError({
          message:
            input.requestId === undefined
              ? `"${thread.title}" has ${pending.length} outstanding approvals; pass the requestId of the one you mean. Open requests: ${open}.`
              : `No outstanding approval with requestId ${input.requestId} in "${thread.title}" — it may have just been answered in the thread. Open requests: ${open}.`,
        });
      }

      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const commandUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);

      yield* startup
        .enqueueCommand(
          orchestrationEngine.dispatch({
            type: "thread.approval.respond",
            // Prefixed so the event log shows the decision came from an
            // orchestrator rather than from the composer.
            commandId: CommandId.make(`orchestrator:${commandUuid}`),
            threadId: input.threadId,
            requestId: ApprovalRequestId.make(request.requestId),
            decision: input.decision,
            createdAt,
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorToolError({
                message: `Failed to answer the approval in "${thread.title}": ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
              }),
          ),
        );

      return {
        threadId: input.threadId,
        threadTitle: thread.title,
        projectTitle,
        requestId: request.requestId,
        decision: input.decision,
        detail: request.detail,
      };
    }),

  stop_thread: (input) =>
    Effect.gen(function* () {
      const { orchestratorProjectId, accessFor, accessOverride } = yield* requireOrchestrator();
      const access = accessFor(input.threadId);
      if (access === "none") {
        return yield* notShared(input.threadId);
      }
      if (access !== "control") {
        return yield* new OrchestratorToolError({
          message: `You may watch conversation ${input.threadId} but not stop it. Tell the user, so they can stop it there. ${raiseToControlHint(accessOverride)}`,
        });
      }

      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const startup = yield* ServerRuntimeStartup;
      const crypto = yield* Crypto.Crypto;

      const shell = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.mapError(snapshotError("read the conversation")));
      if (Option.isNone(shell)) {
        return yield* new OrchestratorToolError({
          message: `No active conversation with id ${input.threadId}. It may have been archived or deleted.`,
        });
      }
      const thread = shell.value;
      // Stopping a sibling would let two orchestrators fight over each other's
      // turns; the same reason send_to_thread refuses them.
      if (thread.projectId === orchestratorProjectId) {
        return yield* new OrchestratorToolError({
          message: `"${thread.title}" is another orchestrator conversation. Orchestrators do not stop each other.`,
        });
      }

      const project = yield* projectionSnapshotQuery
        .getProjectShellById(thread.projectId)
        .pipe(Effect.mapError(snapshotError("read the conversation's project")));
      const projectTitle = Option.match(project, {
        onNone: () => "Unknown project",
        onSome: (value: OrchestrationProjectShell) => value.title,
      });

      // Read before dispatching: once the interrupt lands the projection says
      // nothing was running, and reporting "stopped it" for a thread that had
      // already finished is exactly the kind of thing the user acts on.
      const hadRunningTurn =
        thread.latestTurn?.state === "running" ||
        thread.session?.status === "running" ||
        thread.session?.status === "starting";
      if (!hadRunningTurn) {
        return yield* new OrchestratorToolError({
          message: `"${thread.title}" has no turn running, so there is nothing to stop. Re-read it before telling the user anything about its state.`,
        });
      }

      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const commandUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);

      yield* startup
        .enqueueCommand(
          orchestrationEngine.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make(`orchestrator:${commandUuid}`),
            threadId: input.threadId,
            createdAt,
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorToolError({
                message: `Failed to stop "${thread.title}": ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
              }),
          ),
        );

      return {
        threadId: input.threadId,
        threadTitle: thread.title,
        projectTitle,
        hadRunningTurn,
      };
    }),

  resolve_followup: (input) =>
    Effect.gen(function* () {
      const { orchestratorProjectId, accessFor, accessOverride } = yield* requireOrchestrator();
      const access = accessFor(input.threadId);
      if (access === "none") {
        return yield* notShared(input.threadId);
      }
      // Closing a follow-up writes to the conversation's record, so it needs the
      // same permission as sending to it. Watching is read-only.
      if (access !== "control") {
        return yield* new OrchestratorToolError({
          message: `You may read conversation ${input.threadId} but not close its follow-ups. Tell the user which one you would close and why, and let them clear the chip themselves. ${raiseToControlHint(accessOverride)}`,
        });
      }

      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const startup = yield* ServerRuntimeStartup;
      const crypto = yield* Crypto.Crypto;

      const detail = yield* projectionSnapshotQuery
        .getThreadDetailById(input.threadId)
        .pipe(Effect.mapError(snapshotError("read the conversation")));
      if (Option.isNone(detail)) {
        return yield* new OrchestratorToolError({
          message: `No active conversation with id ${input.threadId}. It may have been archived or deleted.`,
        });
      }
      const thread: OrchestrationThread = detail.value;
      if (thread.projectId === orchestratorProjectId) {
        return yield* new OrchestratorToolError({
          message: `"${thread.title}" is another orchestrator conversation. Orchestrators do not manage each other's follow-ups.`,
        });
      }

      const followups = deriveFollowupRecords(thread.activities);
      const existing = followups.get(input.followupId);
      if (existing === undefined) {
        const pending = [...followups.values()]
          .filter((followup) => followup.status === "pending")
          .map((followup) => `${followup.id} ("${followup.title}")`);
        return yield* new OrchestratorToolError({
          message:
            pending.length === 0
              ? `No follow-up with id ${input.followupId} in "${thread.title}", and it has no pending follow-ups at all. Re-read the thread rather than guessing an id.`
              : `No follow-up with id ${input.followupId} in "${thread.title}". Its pending follow-ups are: ${pending.join(", ")}.`,
        });
      }

      // A spin-off with nowhere to point is worse than leaving it pending: the
      // follow-up disappears from every surface and no record survives of which
      // conversation was supposed to be doing it.
      if (input.status === "spunOff" && input.implementationThreadId === undefined) {
        return yield* new OrchestratorToolError({
          message: `Closing "${existing.title}" as spun off needs the conversation that picked it up. Pass its id as implementationThreadId — the one create_thread returned — or close it as done or dismissed instead.`,
        });
      }
      const implementationThreadId =
        input.status === "spunOff"
          ? (input.implementationThreadId ?? null)
          : existing.implementationThreadId;

      // Already in the requested state: report success without appending
      // another activity, so a retry does not grow the log.
      if (
        existing.status === input.status &&
        existing.implementationThreadId === implementationThreadId
      ) {
        return {
          threadId: input.threadId,
          followupId: existing.id,
          title: existing.title,
          status: input.status,
          implementationThreadId,
        };
      }

      const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const commandUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);

      yield* startup
        .enqueueCommand(
          orchestrationEngine.dispatch({
            type: "thread.followup.upsert",
            commandId: CommandId.make(`orchestrator:${commandUuid}`),
            threadId: input.threadId,
            // Everything but the status and the spin-off link is carried
            // through untouched: the record is re-appended whole, and the
            // latest one per id wins.
            followup: {
              ...existing,
              status: input.status,
              implementationThreadId,
              updatedAt: now,
            },
            createdAt: now,
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorToolError({
                message: `Failed to close the follow-up in "${thread.title}": ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
              }),
          ),
        );

      return {
        threadId: input.threadId,
        followupId: existing.id,
        title: existing.title,
        status: input.status,
        implementationThreadId,
      };
    }),
  read_plan_limits: (input) =>
    Effect.gen(function* () {
      yield* requireOrchestrator();
      const providerRegistry = yield* ProviderRegistry;
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);

      const minutesFrom = (iso: string | null): number | null => {
        if (iso === null) return null;
        const parsed = Date.parse(iso);
        if (Number.isNaN(parsed)) return null;
        return Math.round((parsed - nowMs) / 60_000);
      };

      const providers = yield* providerRegistry.getProviders;
      const accounts = providers
        .filter(
          (provider) => input.instanceId === undefined || provider.instanceId === input.instanceId,
        )
        .map((provider) => {
          const usage = provider.usage;
          const windows = (usage?.available === true ? usage.windows : []).map((window) => ({
            id: window.id,
            label: window.label,
            percent: window.percent,
            resetsAt: window.resetsAt,
            resetsInMinutes: minutesFrom(window.resetsAt),
            severity: window.severity ?? null,
          }));

          // The binding constraint is whichever window is closest to spent —
          // one exhausted window refuses the work no matter how much room the
          // others have.
          const tightestWindow = windows.reduce<(typeof windows)[number] | null>(
            (tightest, window) =>
              window.percent === null
                ? tightest
                : tightest === null || window.percent > (tightest.percent ?? -1)
                  ? window
                  : tightest,
            null,
          );

          const observedAt = usage?.capturedAt ?? null;
          const observedMinutesAgo = observedAt === null ? null : -(minutesFrom(observedAt) ?? 0);
          const ready =
            provider.enabled &&
            provider.installed &&
            isProviderAvailable(provider) &&
            provider.status !== "error";

          return {
            instanceId: provider.instanceId,
            displayName: provider.displayName ?? provider.instanceId,
            plan: usage?.planLabel ?? null,
            ready,
            unavailableReason: ready
              ? null
              : (provider.unavailableReason ?? provider.message ?? "Not usable right now"),
            models: provider.models.map((model) => model.slug),
            windows,
            observedAt,
            observedMinutesAgo,
            tightestWindow,
          };
        });

      return { accounts };
    }),
} satisfies Parameters<typeof OrchestratorToolkit.toLayer>[0];

export const OrchestratorToolkitHandlersLive = OrchestratorToolkit.toLayer(handlers);

/** Exposed for tests. */
export const __testing = {
  derivePendingFollowups,
  summarizeThread,
  needsAttention,
  matchesProject,
};

export type { ThreadId };
