import type { FollowupState } from "./session-logic";

// Build the message that seeds a follow-up — either as a new turn in the
// current thread or as the opening message of a spun-off conversation.
export function buildFollowupPrompt(followup: FollowupState): string {
  const parts = [followup.title.trim()];
  if (followup.detail && followup.detail.trim().length > 0) {
    parts.push(followup.detail.trim());
  }
  if (followup.rationale && followup.rationale.trim().length > 0) {
    parts.push(`Why: ${followup.rationale.trim()}`);
  }
  return parts.join("\n\n");
}

export function buildFollowupThreadTitle(followup: FollowupState): string {
  return followup.title.trim();
}
