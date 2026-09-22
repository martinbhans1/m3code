import { IsoDateTime, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerRuntimeStartup } from "../../../serverRuntimeStartup.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// The follow-up toolkit is every conversation's own to-do deck: the agent
// records what should happen next and what it noticed but is not doing
// (`suggest_followup`), reads back what is still open (`list_followups`), and
// closes out what no longer applies (`resolve_followup`).
//
// `suggest_followup` is deliberately forward-leaning. It used to ask only for
// work that was *out of scope*, which meant a thread that finished what it was
// asked ended with an empty deck — and every reader downstream, the sidebar and
// the orchestrator alike, correctly concluded there was nothing left to do. The
// judgement of whether a piece of work is exhausted can only be made here, in
// the thread, while the context is still loaded; the orchestrator reads
// truncated tails and cannot reconstruct it. So this tool is where that
// judgement gets written down, and the four continuation moves in its
// description are the shape it gets written in.
//
// All three are scoped to the conversation the credential
// belongs to — there is no thread id to pass and no way to reach another
// thread's chips from here. Cross-thread follow-up management is the
// orchestrator toolkit's job, on a separate mount.
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery,
  OrchestrationEngineService,
  ServerRuntimeStartup,
  Crypto.Crypto,
];

export class FollowupToolError extends Schema.TaggedErrorClass<FollowupToolError>()(
  "FollowupToolError",
  {
    message: Schema.String,
  },
) {}

export const FollowupStatus = Schema.Literals(["pending", "spunOff", "done", "dismissed"]);

/**
 * The conversation a follow-up was spun off into, with enough state to say
 * whether anything actually came of it. Present only on `spunOff` follow-ups,
 * and null when that conversation has since been deleted or archived away.
 */
export const FollowupImplementationThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  /**
   * Coarse state of that conversation: "running", "waiting_for_approval",
   * "waiting_for_input", "failed", "interrupted", "completed" (its last turn
   * finished) or "idle" (it never ran).
   *
   * "completed" means its last turn ended, not that the follow-up's work is
   * right — check before telling the user it is done.
   */
  state: Schema.String,
  updatedAt: IsoDateTime,
});

export const FollowupRecord = Schema.Struct({
  /** Pass this back verbatim as `followupId` to close the follow-up. */
  followupId: Schema.String,
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
  rationale: Schema.NullOr(Schema.String),
  /**
   * "pending" is still on the user's deck as a chip. "spunOff" was handed to
   * another conversation, "done" was acted on here, "dismissed" was waved away
   * — none of those three show as chips any more.
   */
  status: FollowupStatus,
  /** The turn that suggested it, so you can find what was being worked on. */
  turnId: Schema.NullOr(Schema.String),
  /** Set on `spunOff` follow-ups; null otherwise, or if that thread is gone. */
  implementationThread: Schema.NullOr(FollowupImplementationThread),
  createdAt: IsoDateTime,
  /** When its status last moved. Equal to `createdAt` while still pending. */
  updatedAt: IsoDateTime,
});

// The field names are spelled out in each annotation because they end up in the
// published JSON schema, and a bare `title`/`detail`/`rationale` triple invites
// the model to reach for `description` or `body` instead. Misnamed bodies are
// recovered on the way in (see the follow-up alias handling in ClaudeAdapter),
// but arriving under the declared name is better than being rescued.
export const SuggestFollowupInput = Schema.Struct({
  title: Schema.String.annotate({
    description:
      "Short imperative headline for the card, e.g. 'Retire the orphaned /tasks route'. Required.",
  }),
  detail: Schema.optional(
    Schema.String.annotate({
      description:
        "The body of the card, in markdown. This field is named `detail` — there is no `description`, `body`, `summary` or `prompt` parameter, and text sent under those names is not what the card shows. Lead with one or two plain-language sentences on what is wrong and why it matters, then the specifics.",
    }),
  ),
  rationale: Schema.optional(
    Schema.String.annotate({
      description:
        "Optional one-liner on why it is worth doing, shown as 'Why:' when the card is expanded. Do not repeat `detail`.",
    }),
  ),
});

export const SuggestFollowupTool = Tool.make("suggest_followup", {
  description:
    'Record what should happen next in this conversation: the rung above the work you just did, and anything you noticed but are not doing. It appears to the user as a card above the composer that they can act on later, either here or in a brand-new conversation.\n\nA turn that shipped something substantial almost always leaves a next rung. Satisfying the request is not the same as exhausting the work, and now is the only cheap moment to say so — you are holding context nobody reading a summary later can reconstruct. Four moves worth reaching for:\n\n- **Extend** — the same technique has other targets. You made one page fast; the next page is still slow.\n- **Deepen** — is this at the floor? Name what the next increment would cost and what it would buy.\n- **Verify** — you just claimed something works. Say what would actually prove it, and what you did not check.\n- **Generalise** — turn the one fix into the thing that kills the class: a lint rule, a helper, a codemod, a test.\n\nRecord the ordinary out-of-scope observations too: a bug you spotted but did not fix, a refactor you had to skip, a missing test. Prefer this over silently dropping one or tacking \'you may also want to…\' onto your reply.\n\nDo NOT use it for work you are about to do this turn (use your todo list) or for questions to the user (use AskUserQuestion). Call list_followups first if there is any chance this is already on the deck; a near-duplicate chip is worse than a missing one, and one already recorded may only need closing with resolve_followup.\n\nA specific rung beats a vague one — "audit the other five list endpoints for the same N+1" is worth recording, "consider further improvements" is not. Skip it only when you genuinely cannot name one.\n\nWrite it for a human skimming one card, not for yourself:\n- `title`: short and imperative, e.g. "Retire the orphaned /tasks route".\n- `detail`: markdown, and it renders as markdown — lists, `inline code` and file links work. Lead with one or two plain-language sentences saying what is wrong and why it matters to the user. Only then give specifics, and only the file paths that are actually needed to start; do not dump every path you touched. If you are laying out alternatives, use a markdown bullet or numbered list — one option per line — never a run-on "(a) … (b) … (c) …" sentence. Aim for well under 100 words; the card is collapsed to two lines until the user expands it, so the first sentence carries the weight.\n- `rationale`: optional one-liner on why it is worth doing, shown as "Why:" when expanded. Do not repeat the detail.',
  parameters: SuggestFollowupInput,
  success: Schema.Struct({ acknowledged: Schema.Boolean }),
  failure: Schema.Never,
  dependencies: [],
})
  .annotate(Tool.Title, "Suggest a follow-up")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const ListFollowupsInput = Schema.Struct({
  status: Schema.optional(
    Schema.Array(FollowupStatus).annotate({
      description:
        'Which statuses to return. Defaults to `["pending"]` — the chips still on the user\'s deck. Pass the others when you need the history: what was already spun off into another conversation, done, or dismissed.',
    }),
  ),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
      description: "Maximum follow-ups to return, oldest first. Defaults to 50.",
    }),
  ),
});

export const ListFollowupsTool = Tool.make("list_followups", {
  description:
    "List this conversation's follow-up to-dos with their current state, so you can see what is still on the user's deck instead of guessing. Use it when the user asks what is outstanding here, before suggesting a follow-up that may already exist, and when they ask you to go through the chips and work out which still apply.\n\nDefaults to the pending ones — the chips they can still see. `counts` covers every status regardless of what you asked for, so you can say \"3 pending, 2 already spun off\" without a second call.\n\nA follow-up is a note somebody wrote earlier, not a fact about the code. Before telling the user one is stale, check the current state of the thing it describes; before closing one as done, check the work is actually there. A `spunOff` follow-up carries the conversation that picked it up and that conversation's state, which tells you whether the work started — not whether it succeeded.",
  parameters: ListFollowupsInput,
  success: Schema.Struct({
    followups: Schema.Array(FollowupRecord),
    /** Totals for the whole conversation, whatever `status` filtered to. */
    counts: Schema.Struct({
      pending: Schema.Int,
      spunOff: Schema.Int,
      done: Schema.Int,
      dismissed: Schema.Int,
    }),
    /** True when `limit` cut the list short. */
    truncated: Schema.Boolean,
  }),
  failure: FollowupToolError,
  dependencies,
})
  .annotate(Tool.Title, "List this conversation's follow-ups")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ResolveFollowupInput = Schema.Struct({
  followupId: Schema.String.annotate({
    description: "The `followupId` exactly as returned by list_followups.",
  }),
  status: Schema.Literals(["done", "dismissed"]).annotate({
    description:
      "'done' when the work actually happened and you have checked it is there. 'dismissed' when it no longer applies — already fixed elsewhere, superseded, or the user decided against it. Do not use 'done' for work that was merely started.",
  }),
});

export const ResolveFollowupTool = Tool.make("resolve_followup", {
  description:
    "Close out one of this conversation's follow-up to-dos, which removes its chip from the user's deck. Use it when you have just finished the work a chip describes, or when you have checked and it no longer applies.\n\nThe chip is the user's, so closing one is their call: say which follow-up you would close and why, and wait for them to agree in that turn. \"Clear the ones that are done\" is such an agreement; a general instruction from earlier in the conversation is not. A follow-up closed by mistake is gone from the deck and they have no way to bring it back, whereas a stale pending one is merely noise — when unsure, leave it and say so.\n\nDo not close a follow-up because you intend to do it. Do the work, verify it, then close it.",
  parameters: ResolveFollowupInput,
  success: Schema.Struct({
    followupId: Schema.String,
    title: Schema.String,
    status: Schema.Literals(["done", "dismissed"]),
    /** Pending follow-ups still on the deck after this one closed. */
    remainingPending: Schema.Int,
  }),
  failure: FollowupToolError,
  dependencies,
})
  .annotate(Tool.Title, "Close a follow-up")
  .annotate(Tool.Readonly, false)
  // Destructive so a conversation running in approval-required mode surfaces a
  // real approve/deny dialog before a chip disappears from the user's deck.
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const FollowupToolkit = Toolkit.make(
  SuggestFollowupTool,
  ListFollowupsTool,
  ResolveFollowupTool,
);
