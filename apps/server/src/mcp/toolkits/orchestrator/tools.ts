import {
  ApprovalRequestId,
  IsoDateTime,
  OrchestratorAccessOverride,
  ProjectId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

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

// The orchestrator toolkit is the "meta conversation" surface: it lets one
// thread see the state of every other thread and hand work back to whichever
// thread already owns the context for it, instead of spawning a fresh agent
// that has to rediscover everything.
//
// It is deliberately narrow. There is no tool here that reads or writes the
// user's code — the orchestrator confers with the user and relays instructions;
// the thread it sends to does the work with its own worktree, branch and model
// already in place.
//
// Visibility is opt-in per conversation by default: a thread is invisible here
// until the user shares it for watching or for control. Most of their work stays
// private to them, which is the point. The exception is the access control in
// the orchestrator's own composer, which overrides every per-conversation
// setting at once — for the case where the user is away from the machine and
// would rather hand over everything than go hunting for the one thread they
// forgot to share.
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery,
  ConversationSearch,
  OrchestrationEngineService,
  ServerRuntimeStartup,
  ServerSettingsService,
  CheckpointDiffQuery,
  GitWorkflowService,
  ProjectSetupScriptRunner,
  ProviderRegistry,
  Crypto.Crypto,
];

export class OrchestratorToolError extends Schema.TaggedErrorClass<OrchestratorToolError>()(
  "OrchestratorToolError",
  {
    message: Schema.String,
  },
) {}

/**
 * Derived agent state for a thread. Mirrors `AgentAwarenessPhase` from
 * `@t3tools/shared/agentAwareness`, plus the two cases awareness declines to
 * name: `interrupted` (the user stopped a turn) and `idle` (settled, or never
 * run).
 */
export const OrchestratorThreadPhase = Schema.Literals([
  "idle",
  "interrupted",
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "failed",
  "stale",
]);

export const OrchestratorThreadSummary = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  projectId: ProjectId,
  projectTitle: Schema.String,
  branch: Schema.NullOr(Schema.String),
  phase: OrchestratorThreadPhase,
  /** Short human phrase for the phase, e.g. "Approval needed". */
  headline: Schema.String,
  /** Extra context for the phase — the failure message, provider name, etc. */
  detail: Schema.NullOr(Schema.String),
  model: Schema.String,
  runtimeMode: Schema.String,
  updatedAt: IsoDateTime,
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  /** True while a turn is in flight; sending now would interrupt it. */
  hasActiveTurn: Schema.Boolean,
  awaitingApproval: Schema.Boolean,
  awaitingUserInput: Schema.Boolean,
  hasPendingFollowups: Schema.Boolean,
  archived: Schema.Boolean,
  pinned: Schema.Boolean,
  /**
   * What the user has shared this conversation for. "watch" is read-only —
   * `send_to_thread` will refuse it.
   */
  orchestratorAccess: Schema.Literals(["watch", "control"]),
  /**
   * True for one of your own earlier conversations. Those are readable so you
   * can pick up what a previous session already decided, but never writable:
   * orchestrators relay work to the threads that do it, never to each other.
   */
  isOrchestratorConversation: Schema.Boolean,
});

export const OrchestratorFollowupSummary = Schema.Struct({
  threadId: ThreadId,
  threadTitle: Schema.String,
  projectTitle: Schema.String,
  followupId: Schema.String,
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
  rationale: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});

/**
 * A follow-up that is no longer on the user's deck, and what became of it.
 *
 * The counterpart to `OrchestratorFollowupSummary`, which only ever describes
 * pending ones. A follow-up handed to another conversation stops being pending
 * the moment it is spun off, so without this the orchestrator has no way to
 * answer "did anything ever come of that?" — it would simply stop seeing it.
 */
export const OrchestratorResolvedFollowup = Schema.Struct({
  followupId: Schema.String,
  title: Schema.String,
  /**
   * "spunOff" was handed to another conversation, "done" was acted on in this
   * one, "dismissed" was waved away. None of the three is proof the work is
   * right — somebody said so, that is all.
   */
  status: Schema.Literals(["spunOff", "done", "dismissed"]),
  /** When it stopped being pending. */
  updatedAt: IsoDateTime,
  /**
   * The conversation that picked the work up, on a `spunOff` follow-up. Null on
   * the others, and on one whose conversation has since been deleted.
   */
  implementationThread: Schema.NullOr(
    Schema.Struct({
      threadId: ThreadId,
      title: Schema.String,
      /**
       * Coarse state of that conversation — "running", "waiting_for_approval",
       * "waiting_for_input", "failed", "interrupted", "completed" (its last turn
       * finished) or "idle" (it never ran). Says whether the work started, not
       * whether it succeeded; confirm with read_thread_changes before reporting
       * anything as finished.
       */
      state: Schema.String,
      updatedAt: IsoDateTime,
    }),
  ),
});

export const OrchestratorPendingQuestionOption = Schema.Struct({
  /** Pass this back verbatim in `selectedOptions` to pick it. */
  label: Schema.String,
  description: Schema.String,
});

export const OrchestratorPendingQuestion = Schema.Struct({
  /** Opaque key for this question — pass it back verbatim as `questionId`. */
  questionId: Schema.String,
  /** Short label the conversation put on the question, e.g. "Blast radius". */
  header: Schema.String,
  question: Schema.String,
  /** True when the question takes several options at once. */
  multiSelect: Schema.Boolean,
  options: Schema.Array(OrchestratorPendingQuestionOption),
});

/**
 * One unanswered `AskUserQuestion` from a conversation, with everything needed
 * to answer it. A single request can carry several questions; all of them have
 * to be answered together, in one `answer_thread_question` call.
 */
export const OrchestratorPendingQuestionSet = Schema.Struct({
  threadId: ThreadId,
  threadTitle: Schema.String,
  projectTitle: Schema.String,
  /** Identifies the request when answering. */
  requestId: ApprovalRequestId,
  createdAt: IsoDateTime,
  questions: Schema.Array(OrchestratorPendingQuestion),
});

/**
 * An approval a thread has stopped to ask for, and enough of it to decide.
 *
 * The projection stores only the request id, so `detail` is recovered from the
 * activity the provider wrote when it asked. Without it the orchestrator could
 * report that something wants approval but never what for, which is the only
 * part the user needs to answer.
 */
export const OrchestratorPendingApproval = Schema.Struct({
  threadId: ThreadId,
  threadTitle: Schema.String,
  projectTitle: Schema.String,
  requestId: Schema.String,
  /** What kind of thing is being approved, when the provider said. */
  requestKind: Schema.NullOr(Schema.Literals(["command", "file-read", "file-change"])),
  /** The command line, file path, or diff summary. Truncated by the provider. */
  detail: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});

export const OrchestratorMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  /** True when `text` was cut short to keep the tool result small. */
  truncated: Schema.Boolean,
  /** True while this message is still being written — treat it as unfinished. */
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
});

export const ListThreadsInput = Schema.Struct({
  projectTitle: Schema.optional(
    Schema.String.annotate({
      description:
        "Case-insensitive substring of the project title, e.g. 'dealjourney'. Omit to span every project.",
    }),
  ),
  onlyNeedingAttention: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Return only threads blocked on the user: awaiting approval, awaiting input, failed, interrupted mid-turn, or holding unanswered follow-ups.",
    }),
  ),
  includeArchived: Schema.optional(Schema.Boolean),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
      description:
        "Maximum threads to return, most recently updated first. Defaults to 40. A full page of 100 is already a large tool result — prefer narrowing with `projectTitle` or `onlyNeedingAttention` over paging through everything.",
    }),
  ),
  offset: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })).annotate({
      description:
        "How many threads to skip before this page, for walking a library too large to return at once. Pass the `nextOffset` from the previous call. Defaults to 0.",
    }),
  ),
});

export const ListThreadsTool = Tool.make("list_threads", {
  description:
    "List the conversations you can currently see, with their agent state — running, waiting for approval, waiting for input, finished, failed, interrupted — plus branch, model and unanswered follow-up counts. Start here when the user asks what they have going on, or which conversation owns a piece of work. Sorted most recently updated first.\n\nThis is a page, not the whole library. `totalMatched` is the real count and `nextOffset` is non-null whenever more remain — say so rather than presenting a page as everything the user has. To find a specific conversation, search_threads or a `projectTitle` filter beats paging; reserve `offset` for when the user genuinely wants a sweep of everything.\n\n`accessMode` says whether this is everything the user has, or only what they shared conversation by conversation; check it before telling them anything about coverage. `orchestratorAccess` on each result says whether you may only watch that one or may also send to it. When the mode is 'per-conversation' and the user asks about work you cannot find, say it is probably not shared rather than that it does not exist.",
  parameters: ListThreadsInput,
  success: Schema.Struct({
    threads: Schema.Array(OrchestratorThreadSummary),
    /** Total matching threads before `limit` and `offset` were applied. */
    totalMatched: Schema.Int,
    /**
     * Offset to pass back for the next page, or null when this page reached the
     * end. Non-null means the user has more than you were shown.
     */
    nextOffset: Schema.NullOr(Schema.Int),
    /**
     * What the user's access control for you is set to right now.
     *
     * "per-conversation" means this list is only what they shared one at a
     * time, so it may be missing work they meant to hand over. The other three
     * are blanket overrides: "read-all" and "control-all" mean this really is
     * every conversation they have (bar the orchestrator's own project),
     * readable in both cases and steerable in the second; "read-shared" means
     * the shared ones, read-only, whatever each says individually.
     */
    accessMode: OrchestratorAccessOverride,
  }),
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "List conversations")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const SearchThreadsInput = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "What to look for, in the user's own words — 'email template merge fields', 'the Telavox dial bug'. Matches thread titles and message content by keyword and by meaning, so paraphrasing works.",
  }),
  exact: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Match the query as a literal substring instead of as keywords — the equivalent of grepping the conversations. Case-sensitive if your query contains a capital letter. Use it for anything where a near-miss is worthless: an identifier like `pending_followup_count`, a file path, an error message, a command, a URL. Keyword search tokenizes and drops punctuation, so it answers a path query with every conversation mentioning any part of it; this either finds the string or tells you nothing contains it. Defaults to false, which is the right choice when the user is describing work in their own words rather than quoting something.",
    }),
  ),
  includeArchived: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});

export const SearchThreadsTool = Tool.make("search_threads", {
  description:
    "Find the conversation that owns a topic, by keyword and by meaning, across the titles and message content of every conversation you can see. Use this the moment the user describes work without naming the thread ('the one where we were fixing the email templates'). Returns a matched snippet per thread so you can confirm you have the right one before acting.\n\nSet `exact` to grep instead: literal substring, no tokenizing or ranking, for identifiers, file paths, error messages and commands. `matchKind` tells you which you got — 'exact' contains your string verbatim, 'content' matched every keyword, 'content-loose' matched only some of them after an all-terms search failed, and 'semantic' matched by meaning with none of your words necessarily present. Only 'exact' is certain; on the others, read the snippet and confirm the thread with the user before acting on it.\n\nAn empty result is only trustworthy in `exact` mode. Otherwise, and always when `list_threads`'s `accessMode` is 'per-conversation', absent means unshared at least as often as it means non-existent — say so rather than telling the user the work does not exist.",
  parameters: SearchThreadsInput,
  success: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        title: Schema.String,
        projectTitle: Schema.String,
        branch: Schema.NullOr(Schema.String),
        snippet: Schema.NullOr(Schema.String),
        matchedRole: Schema.NullOr(Schema.Literals(["user", "assistant", "system"])),
        matchKind: Schema.String,
        archived: Schema.Boolean,
        updatedAt: IsoDateTime,
      }),
    ),
    /**
     * "indexing" means the semantic half of the index is still building, so
     * results are keyword-only for now and a re-run may surface more.
     */
    semanticStatus: Schema.String,
  }),
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Search conversations")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ReadThreadInput = Schema.Struct({
  threadId: ThreadId,
  messageLimit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })).annotate({
      description: "How many of the most recent messages to return. Defaults to 12.",
    }),
  ),
  messageChars: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 20_000 })).annotate({
      description:
        "How much of each message to return before it is cut, in characters. Defaults to 1000, which is sized for orientation. Raise it when a message came back `truncated: true` and you actually need the rest of it — a decision the user wrote out, a note you are being asked about. Pair a large value with a small `messageLimit`: the whole result is capped regardless, and oldest messages are dropped first to stay inside it.",
    }),
  ),
});

export const ReadThreadTool = Tool.make("read_thread", {
  description:
    "Read the tail of one conversation: its current state, its most recent messages, any question it is stopped on, and its follow-ups both open and closed. Use it to tell the user where a thread actually stands, and to check what the thread already knows before you send it more work — so the message you relay does not repeat what it just did. Message text is truncated; this is for orientation, not for reviewing code.\n\nWhen `pendingQuestions` is non-empty the thread is parked waiting for an answer and will do nothing until it gets one. Read the options out to the user, and answer with answer_thread_question once they have chosen. `pendingApprovals` parks it just as hard, and carries the command or file it is asking to touch — put that in front of the user verbatim and relay their decision with respond_to_approval.\n\n`recentlyResolvedFollowups` is the memory the follow-up deck does not have: what was already spun off into another conversation, done, or dismissed. Check it before offering to start work on something, or you will hand out a job somebody is already doing — and it is where you find the conversation that picked a follow-up up.",
  parameters: ReadThreadInput,
  success: Schema.Struct({
    thread: OrchestratorThreadSummary,
    messages: Schema.Array(OrchestratorMessage),
    /** Unanswered questions blocking the thread, oldest first. */
    pendingQuestions: Schema.Array(OrchestratorPendingQuestionSet),
    /** Unanswered approval requests blocking the thread, oldest first. */
    pendingApprovals: Schema.Array(OrchestratorPendingApproval),
    pendingFollowups: Schema.Array(OrchestratorFollowupSummary),
    /**
     * The most recently closed follow-ups, newest first, capped at ten. Not the
     * whole history — enough to see what has already been handled.
     */
    recentlyResolvedFollowups: Schema.Array(OrchestratorResolvedFollowup),
  }),
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read a conversation")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

/** The four independently-paged sections of `list_pending`. */
export const OrchestratorPendingSection = Schema.Literals([
  "approvals",
  "questions",
  "failed",
  "followups",
]);

export const ListPendingInput = Schema.Struct({
  projectTitle: Schema.optional(Schema.String),
  sections: Schema.optional(
    Schema.Array(OrchestratorPendingSection).annotate({
      description:
        "Which sections to return. Omit for all four. Narrow to one when you are working through a backlog — 'followups' alone pages much further for the same result size.",
    }),
  ),
  since: Schema.optional(
    Schema.String.annotate({
      description:
        "Only include items from this moment onwards, as an ISO 8601 timestamp or a plain 'YYYY-MM-DD' date (interpreted as UTC midnight). Threads are filtered on when they last changed, follow-ups on when they were recorded. Use for 'what came up today'; omit for the whole backlog.",
    }),
  ),
  until: Schema.optional(
    Schema.String.annotate({
      description:
        "Only include items up to this moment, same formats as `since`. A plain date means the end of that day, so passing the same date as `since` and `until` gives you exactly that one day. Use `until` alone to reach the oldest items — the ones most likely to have been forgotten.",
    }),
  ),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
      description:
        "Maximum items per section, so one busy section cannot crowd out the rest. Defaults to 25.",
    }),
  ),
  offset: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })).annotate({
      description:
        "How many items to skip within each requested section. Pair with a single entry in `sections` — a shared offset across four sections of different lengths is rarely what you want. Defaults to 0.",
    }),
  ),
});

/**
 * True totals per section, before `limit`/`offset`. Reported separately so the
 * orchestrator can tell the user how much is actually waiting without having to
 * fetch all of it — the counts are the answer to "what am I forgetting?", the
 * arrays are only as much of it as fits.
 */
export const OrchestratorPendingCounts = Schema.Struct({
  awaitingApproval: Schema.Int,
  awaitingUserInput: Schema.Int,
  failed: Schema.Int,
  /** Null when `sections` left follow-ups out — unknown, not zero. */
  pendingFollowups: Schema.NullOr(Schema.Int),
});

export const ListPendingTool = Tool.make("list_pending", {
  description:
    "List everything currently waiting on the user across all conversations: threads blocked on an approval, threads asking a question, threads that failed, and follow-up to-dos agents recorded but nobody has acted on. Use this for 'what am I forgetting?' — unanswered follow-ups in particular are invisible unless their thread is reopened.\n\nEach section is capped and paged independently. `counts` holds the true totals and is filled in whether or not you asked for that section's items, so lead with those — \"57 follow-ups pending, here are the oldest 25\" is the useful answer, and reporting a capped page as the whole backlog is not. To work through one section, pass that one name in `sections` with an `offset`; to narrow by time, use `since`/`until`.\n\nOnly page forward if you are just reading. The moment you resolve a follow-up or answer a question, the list shrinks under you and `nextOffset` would skip past everything that shifted into the gap — call again with `offset: 0` instead, and repeat until the count reaches zero.\n\n`pendingQuestions` carries the actual questions and options behind `awaitingUserInput`, so you can put the choice to the user here and answer it with answer_thread_question without opening each thread. `pendingApprovalRequests` does the same for `awaitingApproval` — the command or file each thread is asking to touch — and respond_to_approval answers those. A thread listed in either section with nothing in the matching array means the request could not be read from here; open it with read_thread rather than reporting it as having nothing pending.",
  parameters: ListPendingInput,
  success: Schema.Struct({
    awaitingApproval: Schema.Array(OrchestratorThreadSummary),
    awaitingUserInput: Schema.Array(OrchestratorThreadSummary),
    /**
     * The questions behind the `awaitingUserInput` page, ready to answer. Scoped
     * to the threads on that page, so paging `awaitingUserInput` pages these too.
     */
    pendingQuestions: Schema.Array(OrchestratorPendingQuestionSet),
    /**
     * The approvals behind the `awaitingApproval` page, ready to respond to.
     * Scoped to the threads on that page, exactly as `pendingQuestions` is.
     */
    pendingApprovalRequests: Schema.Array(OrchestratorPendingApproval),
    failed: Schema.Array(OrchestratorThreadSummary),
    pendingFollowups: Schema.Array(OrchestratorFollowupSummary),
    /** True totals per section, before the cap. Report these, not the array lengths. */
    counts: OrchestratorPendingCounts,
    /**
     * Offset for the next page, or null when every requested section was
     * returned whole. Non-null means something waiting was left out.
     */
    nextOffset: Schema.NullOr(Schema.Int),
    /** Sections actually included in this result. */
    sections: Schema.Array(OrchestratorPendingSection),
  }),
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "List what is waiting")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const SendToThreadInput = Schema.Struct({
  threadId: ThreadId.annotate({
    description: "Target thread. Confirm it is the right one with search_threads or read_thread.",
  }),
  message: Schema.String.annotate({
    description:
      "The prompt to post as the user, written in their voice and addressed to that thread's agent. Include the context that thread needs but does not have; do not re-explain what it already did.",
  }),
  steerRunningTurn: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Required to send into a thread that is mid-turn. The message is appended to the turn already running — the agent picks it up at its next step and keeps going as the same turn. It is not an abort: nothing that has already been done is undone. But it does redirect an agent mid-task, so it is worth saying only what you would want it to read while working. Defaults to false, which refuses rather than steering by accident.",
    }),
  ),
});

export const SendToThreadTool = Tool.make("send_to_thread", {
  description:
    "Post a message into an existing conversation as the user, starting a turn there with that thread's own context, worktree, branch and model intact. This is how work gets handed back to the thread that owns it instead of starting over somewhere new.\n\nAsk first, every time. Show the user the exact message and the thread you intend to send it to, and wait for them to say yes in that turn — do not infer approval from an earlier instruction, and never send to more than one thread per approval. A successful result means the turn was accepted, not that it has run: the target thread works on its own from there and can still fail to start, so report what you sent and check back with read_thread rather than assuming it landed.",
  parameters: SendToThreadInput,
  success: Schema.Struct({
    threadId: ThreadId,
    threadTitle: Schema.String,
    projectTitle: Schema.String,
    /** True when the message was injected into a turn already in progress. */
    steeredRunningTurn: Schema.Boolean,
  }),
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Send a message to a conversation")
  .annotate(Tool.Readonly, false)
  // Destructive so a meta thread running in approval-required mode surfaces a
  // real approve/deny dialog before anything is posted into another thread.
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const CreateThreadInput = Schema.Struct({
  projectTitle: Schema.String.annotate({
    description:
      "Case-insensitive substring of the project the conversation belongs in, e.g. 'dealjourney'. Must match exactly one project; run list_threads first if you are unsure what exists.",
  }),
  title: Schema.String.annotate({
    description:
      "Short title for the new conversation, in the user's terms — what the work is, not who asked for it.",
  }),
  message: Schema.String.annotate({
    description:
      "The opening prompt, written as the user and addressed to a fresh agent that knows nothing. Spell out the task, the files or areas involved, and anything decided in this conversation that it would otherwise have to rediscover.",
  }),
  envMode: Schema.optional(
    Schema.Literals(["local", "worktree"]).annotate({
      description:
        "'local' (the default) works directly in the project's checkout, like most conversations. 'worktree' gives the new conversation its own git worktree and branch, so it cannot collide with work already running in that project — use it whenever you are starting a second track on a repository something else is already touching. Worktree setup can fail (dirty repo, no git, detached HEAD); when it does, nothing is created and you get the git error back.",
    }),
  ),
  model: Schema.optional(
    Schema.String.annotate({
      description:
        "Which model the new conversation should run on. The default sanctioned choices are claude-opus-5 and gpt-5.6; the user may customize that list in settings. Passing an unrecognised one returns the current allowed list. Omit to inherit the project's own default; choose deliberately when another model is better suited to the work.",
    }),
  ),
  runtimeMode: Schema.optional(
    RuntimeMode.annotate({
      description:
        "Permissions for the new conversation: 'approval-required' asks before commands and edits, 'auto-accept-edits' allows edits only, 'full-access' allows both. Defaults to approval-required — start supervised unless the user says otherwise.",
    }),
  ),
  access: Schema.optional(
    Schema.Literals(["watch", "control"]).annotate({
      description:
        "How much of the new conversation you keep afterwards. Defaults to 'control' so you can follow up in the thread you opened; 'watch' if you should only be able to read it.",
    }),
  ),
});

export const CreateThreadTool = Tool.make("create_thread", {
  description:
    "Open a brand new conversation in one of the user's projects and start it with an opening prompt. Use this when the work does not belong to any existing thread — a separate task, a clean slate after a thread has gone long, or a second track the user wants running alongside the first. When an existing thread already owns the context, prefer send_to_thread; starting fresh means the new agent rediscovers everything.\n\nAsk first, every time. Show the user the project, the title and the exact opening prompt, and wait for them to say yes in that turn — one conversation per approval. The new conversation is shared with you afterwards so you can check on it with read_thread and read_thread_changes. A successful result means the turn was accepted, not that it has run.\n\nBy default the conversation works in the project's own checkout, which is fine when nothing else is running there. If another conversation is already working in that project, pass envMode:'worktree' so the new one gets its own branch and checkout instead of editing the same files underneath it.\n\nCheck read_plan_limits before settling on the model: an hour of work started against an account whose session window is nearly spent stops partway through, and a different account or a short wait usually costs nothing.",
  parameters: CreateThreadInput,
  success: Schema.Struct({
    threadId: ThreadId,
    threadTitle: Schema.String,
    projectTitle: Schema.String,
    /** The model it actually started on, resolved or inherited. */
    model: Schema.String,
    /**
     * The permissions it started with. Report this to the user: a conversation
     * on "approval-required" stops at its first command and waits for them.
     */
    runtimeMode: Schema.String,
    /** The branch it is on — a fresh one for a worktree conversation, null for a local one. */
    branch: Schema.NullOr(Schema.String),
    /** Its own checkout, or null when it shares the project's. */
    worktreePath: Schema.NullOr(Schema.String),
    /**
     * What happened to the project's setup script, for worktree conversations:
     * "started", "no-script", or "failed" (which leaves the worktree usable but
     * possibly missing dependencies). Null for local conversations, which reuse
     * the project checkout and need no setup.
     */
    setupScript: Schema.NullOr(Schema.String),
    /** What you retain on the conversation you just opened. */
    orchestratorAccess: Schema.Literals(["watch", "control"]),
  }),
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Start a new conversation")
  .annotate(Tool.Readonly, false)
  // Destructive so a meta thread running in approval-required mode surfaces a
  // real approve/deny dialog before a new conversation is created and run.
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ReadThreadChangesInput = Schema.Struct({
  threadId: ThreadId,
  includePatch: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Include the actual unified diff, not just the file list. Expensive and truncated — ask for it only when you are going to read the code, and prefer narrowing with `turnCount` first. Defaults to false.",
    }),
  ),
  turnCount: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })).annotate({
      description:
        "Limit the patch to the changes made by this one turn (use a `turnCount` from the returned turns list). Omit to diff the whole conversation from its starting point.",
    }),
  ),
});

export const ReadThreadChangesTool = Tool.make("read_thread_changes", {
  description:
    "See what changed on disk while a conversation ran: the files touched with added/removed line counts, turn by turn, and optionally the diff itself. Better than testimony — `read_thread` only tells you what the agent said it did, and agents routinely report work as finished that does not compile or was never written.\n\nHow much better depends on `attribution`, and you have to read it. Snapshots cover the whole checkout, not one conversation's edits, so a thread with its own worktree gives you close to proof while a thread sharing the project checkout gives you an upper bound that includes every other conversation working there. `sharedCheckout` and `otherThreadsInCheckout` say which case you are in. Never present a shared-checkout figure as what this conversation did.\n\nUse it before telling the user something is done, before closing a follow-up as done, and when deciding whether a thread needs a review pass. The file list is cheap; the patch is not, so leave `includePatch` off until you know which turn you care about. Both are truncated, so treat a truncated result as a reason to open the conversation rather than as the whole picture.\n\nThe line counts add up each turn's diff, so a file rewritten across several turns counts every pass. Quote them as how much work went in, never as the size of the final change — for that, read the patch.",
  parameters: ReadThreadChangesInput,
  success: Schema.Struct({
    threadId: ThreadId,
    threadTitle: Schema.String,
    projectTitle: Schema.String,
    branch: Schema.NullOr(Schema.String),
    /** Null for a thread working directly in the project checkout. */
    worktreePath: Schema.NullOr(Schema.String),
    /**
     * Every distinct file the conversation has touched, most-changed first.
     *
     * Counts are work done, not net change: they sum each turn's diff, so a line
     * written in one turn and rewritten in the next counts twice. Good for "how
     * much happened here"; for what the code actually ends up looking like, read
     * the patch.
     */
    files: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        churnAdditions: Schema.Int,
        churnDeletions: Schema.Int,
      }),
    ),
    /** Summed the same way as `files` — churn across turns, not a net total. */
    totalChurnAdditions: Schema.Int,
    totalChurnDeletions: Schema.Int,
    /** Per-turn breakdown, oldest first, so you can see how the work built up. */
    turns: Schema.Array(
      Schema.Struct({
        turnCount: Schema.Int,
        fileCount: Schema.Int,
        additions: Schema.Int,
        deletions: Schema.Int,
        completedAt: Schema.NullOr(IsoDateTime),
      }),
    ),
    /** Present only when `includePatch` was set. */
    patch: Schema.NullOr(Schema.String),
    /** True when `patch` or `files` was cut short. */
    truncated: Schema.Boolean,
    /**
     * True when the conversation works in the project's own checkout instead of
     * a private worktree — in which case these numbers describe the checkout,
     * not the conversation.
     */
    sharedCheckout: Schema.Boolean,
    /** How many other active conversations write to that same checkout. */
    otherThreadsInCheckout: Schema.Int,
    /**
     * Plain-language statement of how far these numbers can be trusted as this
     * conversation's work. Read it before crediting anything here to the thread.
     */
    attribution: Schema.String,
  }),
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read a conversation's code changes")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AnswerThreadQuestionInput = Schema.Struct({
  threadId: ThreadId.annotate({
    description: "The conversation that is waiting on an answer.",
  }),
  requestId: Schema.optional(
    ApprovalRequestId.annotate({
      description:
        "The `requestId` exactly as returned by read_thread or list_pending. Omit only when the thread has a single unanswered question set — with more than one pending, this says which.",
    }),
  ),
  answers: Schema.Array(
    Schema.Struct({
      questionId: Schema.String.annotate({
        description: "The `questionId` exactly as returned, one entry per question in the request.",
      }),
      selectedOptions: Schema.optional(
        Schema.Array(Schema.String).annotate({
          description:
            "Option labels to pick, copied verbatim from the question's options. One label unless the question is multiSelect. Leave off if you are writing a custom answer instead.",
        }),
      ),
      customAnswer: Schema.optional(
        Schema.String.annotate({
          description:
            "A free-text answer, for when none of the options is what the user actually said. Takes precedence over `selectedOptions`. Use the user's own words — this goes to the other agent as the user's reply.",
        }),
      ),
    }),
  ).annotate({
    description:
      "One entry per question in the request. All of them must be answered — the thread stays parked until the whole set comes back.",
  }),
});

export const AnswerThreadQuestionTool = Tool.make("answer_thread_question", {
  description:
    "Answer the question a conversation is stopped on, exactly as if the user had clicked the option in that thread — which unparks it and lets its turn carry on. Get the questions and their options from read_thread or list_pending first; the ids and option labels have to come back verbatim.\n\nRelay the user's decision, never your own. Show them the question and the options in their own conversation and wait for them to choose in that turn — a question routed here is still their call, and answering it is irreversible: the other agent acts on the answer immediately and there is no way to take it back. Do not answer more than one request per approval, and do not infer an answer from something they said earlier about a different thread.\n\nIf none of the options fits what they said, pass their wording as `customAnswer` rather than forcing the nearest option.",
  parameters: AnswerThreadQuestionInput,
  success: Schema.Struct({
    threadId: ThreadId,
    threadTitle: Schema.String,
    projectTitle: Schema.String,
    requestId: ApprovalRequestId,
    /** What was actually sent, resolved to the question's canonical labels. */
    answered: Schema.Array(
      Schema.Struct({
        questionId: Schema.String,
        selectedOptions: Schema.Array(Schema.String),
        customAnswer: Schema.NullOr(Schema.String),
      }),
    ),
  }),
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Answer a conversation's question")
  .annotate(Tool.Readonly, false)
  // Destructive so a meta thread running in approval-required mode surfaces a
  // real approve/deny dialog before an answer is committed to another thread.
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

/**
 * The subset of the engine's decisions an orchestrator may take. "cancel" is
 * deliberately absent: it exists so a composer dialog can be dismissed without
 * deciding, which is not something a relayed answer can mean.
 */
export const OrchestratorApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "decline",
]);

export const RespondToApprovalInput = Schema.Struct({
  threadId: ThreadId.annotate({
    description: "The conversation that has stopped to ask for approval.",
  }),
  decision: OrchestratorApprovalDecision.annotate({
    description:
      "'accept' allows this one request. 'acceptForSession' allows it and stops that conversation asking again for the rest of its session — only when the user says so in those terms. 'decline' refuses it; the agent carries on without whatever it asked for.",
  }),
  requestId: Schema.optional(
    Schema.String.annotate({
      description:
        "Which approval, exactly as returned by read_thread or list_pending. Optional only when the thread has exactly one outstanding; with several, a call without it is refused rather than guessed.",
    }),
  ),
});

export const RespondToApprovalTool = Tool.make("respond_to_approval", {
  description:
    "Allow or refuse something a conversation has stopped to ask permission for — running a command, reading a file, writing a change. A thread waiting on an approval does nothing at all until it gets one, and it cannot be unblocked by sending it a message.\n\nShow the user what is actually being asked, in the words of the request, and wait for them to decide in that turn. One approval per answer; never infer a second one from the first. This is the user's decision to make and it takes effect immediately — the command runs, the file is written — so relay their answer and nothing more. If they have not seen the detail of what it wants to do, you are not ready to call this.\n\nUse 'acceptForSession' only when the user says to stop being asked; it silences that conversation's prompts for the rest of its session, which is a much larger thing to agree to than the request in front of them.",
  parameters: RespondToApprovalInput,
  success: Schema.Struct({
    threadId: ThreadId,
    threadTitle: Schema.String,
    projectTitle: Schema.String,
    requestId: Schema.String,
    decision: OrchestratorApprovalDecision,
    /** What was approved, echoed back so you can report what you actually did. */
    detail: Schema.NullOr(Schema.String),
  }),
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Answer an approval request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const StopThreadInput = Schema.Struct({
  threadId: ThreadId.annotate({
    description: "The conversation whose current turn should be stopped.",
  }),
});

export const StopThreadTool = Tool.make("stop_thread", {
  description:
    "Interrupt the turn a conversation is running. Use it for a turn that has stalled — one still marked running long after it went quiet, which `phase: 'stale'` reports — or when the user wants an agent stopped.\n\nStopping is not undoing: everything the agent already did stays done, files included. The turn simply ends where it is, and the conversation becomes usable again.\n\nAsk first, every time, and only stop the thread the user named. Interrupting an agent that is genuinely mid-task throws away the work it had not finished, so a thread reported as running is one to ask about rather than tidy up. Check what it managed with read_thread_changes before offering to stop it, and again afterwards before you report what it got done.",
  parameters: StopThreadInput,
  success: Schema.Struct({
    threadId: ThreadId,
    threadTitle: Schema.String,
    projectTitle: Schema.String,
    /**
     * False when nothing was running by the time the stop landed — the turn had
     * already ended, so report that rather than claiming to have stopped it.
     */
    hadRunningTurn: Schema.Boolean,
  }),
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop a conversation's turn")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ResolveFollowupInput = Schema.Struct({
  threadId: ThreadId.annotate({
    description: "The conversation the follow-up belongs to.",
  }),
  followupId: Schema.String.annotate({
    description: "The `followupId` exactly as returned by read_thread or list_pending.",
  }),
  status: Schema.Literals(["done", "dismissed", "spunOff"]).annotate({
    description:
      "'done' when the work actually happened — you have checked the thread and it is finished. 'dismissed' when the user decided not to do it. 'spunOff' when you have just started the work somewhere else, which records the link instead of claiming it is finished. Do not use 'done' for work that was merely started.",
  }),
  implementationThreadId: Schema.optional(
    ThreadId.annotate({
      description:
        "The conversation now doing the work, for `spunOff` — normally the `threadId` create_thread just returned. Required with 'spunOff' and ignored otherwise; without it the link is lost and nobody can tell where the follow-up went.",
    }),
  ),
});

export const ResolveFollowupTool = Tool.make("resolve_followup", {
  description:
    "Close out a follow-up to-do, so it stops being reported as waiting on the user. Follow-ups stay pending until somebody clears them, so ones that were quietly handled inside their own thread pile up in list_pending forever and drown the ones that still matter.\n\nOnly close what you have actually confirmed: read the thread first and check the work is finished, or get the user to tell you it is. If in doubt, leave it pending and say so — a follow-up wrongly marked done is invisible from then on, whereas a stale pending one is merely noise. Ask the user before dismissing anything they have not already decided about.\n\nWhen you hand a follow-up to a new conversation with create_thread, close it as 'spunOff' with that conversation's `implementationThreadId` in the same breath. That is what stops it being offered again, and it is the only record of where the work went — read_thread reports it back under `recentlyResolvedFollowups`.",
  parameters: ResolveFollowupInput,
  success: Schema.Struct({
    threadId: ThreadId,
    followupId: Schema.String,
    title: Schema.String,
    status: Schema.Literals(["done", "dismissed", "spunOff"]),
    /** The conversation the work went to, for a `spunOff` follow-up. */
    implementationThreadId: Schema.NullOr(ThreadId),
  }),
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Close a follow-up")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OrchestratorPlanLimitWindow = Schema.Struct({
  /** Provider's own name for the window, e.g. `five_hour`, `seven_day`. */
  id: Schema.String,
  /** How it reads to a person: "Session", "Weekly", "Weekly (Opus)". */
  label: Schema.String,
  /** How much of the window is spent, 0-100, or null if unreported. */
  percent: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(IsoDateTime),
  /**
   * Minutes until this window empties out.
   *
   * The number that decides whether a nearly spent window matters: work that
   * takes an hour cannot be started against a window at 95% that resets in two
   * hours, but the same window resetting in ten minutes is barely an obstacle.
   */
  resetsInMinutes: Schema.NullOr(Schema.Number),
  /** The provider's own view: "normal", "warning", or "critical". */
  severity: Schema.NullOr(Schema.String),
});

export const OrchestratorPlanLimits = Schema.Struct({
  instanceId: Schema.String,
  displayName: Schema.String,
  /** Subscription tier as the provider names it, e.g. "max". Null if unknown. */
  plan: Schema.NullOr(Schema.String),
  /** Whether work could be started on it at all — installed, enabled, signed in. */
  ready: Schema.Boolean,
  /** Why it cannot be used, when `ready` is false. */
  unavailableReason: Schema.NullOr(Schema.String),
  /** Model ids this account can run. */
  models: Schema.Array(Schema.String),
  windows: Schema.Array(OrchestratorPlanLimitWindow),
  /**
   * When these numbers were last read from the provider, and how long ago.
   *
   * Load-bearing, not decoration: an account only reports its limits while a
   * conversation is running on it, so an account left idle keeps reporting
   * whatever it last saw. A reading hours old says what was true then — treat a
   * stale low number as unknown rather than as headroom.
   */
  observedAt: Schema.NullOr(IsoDateTime),
  observedMinutesAgo: Schema.NullOr(Schema.Number),
  /**
   * The window closest to being spent, which is the one that will actually
   * stop the work. Null when the account reports no usable numbers.
   */
  tightestWindow: Schema.NullOr(OrchestratorPlanLimitWindow),
});

export const ReadPlanLimitsInput = Schema.Struct({
  instanceId: Schema.optional(
    Schema.String.annotate({
      description:
        "Restrict the answer to one account. Omit to see every configured account, which is normally what you want — the point is to compare them.",
    }),
  ),
});

export const ReadPlanLimitsTool = Tool.make("read_plan_limits", {
  description:
    "How much of each provider account's rate-limited allowance is already spent, and when each window resets. Read this before choosing which account or model to start work on, and before handing a long job to a conversation already running on a nearly spent account.\n\nEach account reports one or more windows - typically a rolling session window of a few hours and a weekly one, sometimes a further window scoped to a single model. Work is refused when any one of them is exhausted, so the tightest window is the one that decides. Judge it against the reset time rather than the percentage alone: a window at 90% that resets in fifteen minutes will not stop a job that takes an hour, while the same 90% with two days to run is a reason to send the work elsewhere.\n\nThe numbers come from whatever the provider last reported, and it only reports while a conversation is running on that account. Check how long ago each was observed: on an account that has been idle, a low reading is old news, not proof of headroom.",
  parameters: ReadPlanLimitsInput,
  success: Schema.Struct({
    accounts: Schema.Array(OrchestratorPlanLimits),
  }),
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Check plan limits")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OrchestratorToolkit = Toolkit.make(
  ListThreadsTool,
  SearchThreadsTool,
  ReadThreadTool,
  ListPendingTool,
  SendToThreadTool,
  CreateThreadTool,
  AnswerThreadQuestionTool,
  RespondToApprovalTool,
  StopThreadTool,
  ResolveFollowupTool,
  ReadThreadChangesTool,
  ReadPlanLimitsTool,
);
