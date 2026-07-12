import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

// A lightweight tool the agent calls to surface a follow-up to-do it noticed
// while working. The follow-up is recorded by the provider adapter (which
// observes this call via the permission callback) and shown to the user as a
// chip they can act on later — here, or in a brand-new conversation. The tool
// itself just acknowledges; see ClaudeAdapter.emitFollowupSuggested.
export const SuggestFollowupInput = Schema.Struct({
  title: Schema.String,
  detail: Schema.optional(Schema.String),
  rationale: Schema.optional(Schema.String),
});

export const SuggestFollowupTool = Tool.make("suggest_followup", {
  description:
    "Record a follow-up to-do you noticed but are NOT doing this turn — a separate bug, refactor, cleanup, or improvement that is out of scope for the user's current request. It appears to the user as a chip they can act on later, either in this conversation or a brand-new one. Prefer this over silently dropping an observation or tacking 'you may also want to…' onto your reply. Do NOT use it for work you are about to do (use your todo list) or for questions to the user (use AskUserQuestion). Provide a short imperative `title`, a `detail` with enough context to start the work cold, and an optional `rationale`.",
  parameters: SuggestFollowupInput,
  success: Schema.Struct({ acknowledged: Schema.Boolean }),
  failure: Schema.Never,
  dependencies: [],
})
  .annotate(Tool.Title, "Suggest a follow-up")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const FollowupToolkit = Toolkit.make(SuggestFollowupTool);
