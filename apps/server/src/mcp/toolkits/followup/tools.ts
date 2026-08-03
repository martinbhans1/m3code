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
    'Record a follow-up to-do you noticed but are NOT doing this turn — a separate bug, refactor, cleanup, or improvement that is out of scope for the user\'s current request. It appears to the user as a card above the composer that they can act on later, either in this conversation or a brand-new one. Prefer this over silently dropping an observation or tacking \'you may also want to…\' onto your reply. Do NOT use it for work you are about to do (use your todo list) or for questions to the user (use AskUserQuestion).\n\nWrite it for a human skimming one card, not for yourself:\n- `title`: short and imperative, e.g. "Retire the orphaned /tasks route".\n- `detail`: markdown, and it renders as markdown — lists, `inline code` and file links work. Lead with one or two plain-language sentences saying what is wrong and why it matters to the user. Only then give specifics, and only the file paths that are actually needed to start; do not dump every path you touched. If you are laying out alternatives, use a markdown bullet or numbered list — one option per line — never a run-on "(a) … (b) … (c) …" sentence. Aim for well under 100 words; the card is collapsed to two lines until the user expands it, so the first sentence carries the weight.\n- `rationale`: optional one-liner on why it is worth doing, shown as "Why:" when expanded. Do not repeat the detail.',
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
