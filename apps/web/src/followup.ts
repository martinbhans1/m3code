import type { FollowupState } from "./session-logic";

// Build the message that seeds a follow-up — either as a new turn in the
// current thread or as the opening message of a spun-off conversation.
//
// `extraContext` is what the user typed into the "Start custom…" dialog. It is
// labelled and placed last so the agent reads it as the operator's own
// amendment to the suggestion rather than as part of what the agent proposed —
// a follow-up is often too terse to act on, and the correction has to outrank
// the original wording when the two disagree.
export function buildFollowupPrompt(followup: FollowupState, extraContext?: string): string {
  const parts = [followup.title.trim()];
  if (followup.detail && followup.detail.trim().length > 0) {
    parts.push(followup.detail.trim());
  }
  if (followup.rationale && followup.rationale.trim().length > 0) {
    parts.push(`Why: ${followup.rationale.trim()}`);
  }
  const extra = extraContext?.trim() ?? "";
  if (extra.length > 0) {
    parts.push(
      `Additional context added by the user when starting this task (it takes precedence over the suggestion above):\n\n${extra}`,
    );
  }
  return parts.join("\n\n");
}

export function buildFollowupThreadTitle(followup: FollowupState): string {
  return followup.title.trim();
}
