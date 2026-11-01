import {
  FOLLOWUP_ACTIVITY_KIND,
  type OrchestrationThreadActivity,
  type TurnId,
} from "@t3tools/contracts";

/**
 * Agent-suggested follow-ups as every client reads them.
 *
 * Follow-ups ride the activity log rather than a thread column: each create or
 * status change appends another activity carrying the full record, and the
 * latest one per id wins. Web, mobile and the server's MCP tools all need the
 * same answer to "what is on the deck", so the reading lives here.
 */
export type FollowupStatus = "pending" | "spunOff" | "done" | "dismissed";

export interface FollowupState {
  id: string;
  title: string;
  detail: string | null;
  rationale: string | null;
  status: FollowupStatus;
  turnId: TurnId | null;
  createdAt: string;
  updatedAt: string;
}

// The body of a follow-up as the agent actually sent it to `suggest_followup`.
//
// The tool declares `detail`, but a sizeable minority of calls put the body
// under another name. Those calls still succeeded, so the chip was recorded
// with a bare title and the description was lost. The adapter now reads these
// names as calls come in (keep the two lists in step); this recovers the same
// text for every follow-up recorded before it did, straight from the tool call
// still sitting in the activity log.
const FOLLOWUP_DETAIL_ALIASES = [
  "detail",
  "description",
  "body",
  "details",
  "prompt",
  "text",
  "notes",
  "summary",
] as const;
const FOLLOWUP_RATIONALE_ALIASES = ["rationale", "why", "reason"] as const;

function readAliasedString(
  input: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * The bodies the agent actually sent to `suggest_followup`, keyed by tool_use
 * id — which is also the follow-up's own id, so a record missing its detail can
 * be matched back to the call that made it.
 */
export function collectFollowupToolCallBodies(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Map<string, { detail: string | null; rationale: string | null }> {
  const byToolUseId = new Map<string, { detail: string | null; rationale: string | null }>();
  for (const activity of activities) {
    if (activity.kind !== "tool.completed") continue;
    const data = asRecord(asRecord(activity.payload)?.data);
    if (!data || typeof data.toolName !== "string" || !data.toolName.endsWith("suggest_followup")) {
      continue;
    }
    const result = asRecord(data.result);
    const input = asRecord(data.input);
    if (!result || typeof result.tool_use_id !== "string" || !input) continue;
    byToolUseId.set(result.tool_use_id, {
      detail: readAliasedString(input, FOLLOWUP_DETAIL_ALIASES),
      rationale: readAliasedString(input, FOLLOWUP_RATIONALE_ALIASES),
    });
  }
  return byToolUseId;
}

function compareByLogOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }
  return left.createdAt.localeCompare(right.createdAt);
}

export function deriveFollowups(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): FollowupState[] {
  const ordered = [...activities].toSorted(compareByLogOrder);
  const toolInputs = collectFollowupToolCallBodies(ordered);
  const byId = new Map<string, FollowupState>();
  for (const activity of ordered) {
    if (activity.kind !== FOLLOWUP_ACTIVITY_KIND) continue;
    const raw = asRecord(asRecord(activity.payload)?.followup);
    if (!raw) continue;
    const id = typeof raw.id === "string" ? raw.id : "";
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (id.length === 0 || title.length === 0) continue;
    const status: FollowupStatus =
      raw.status === "spunOff" || raw.status === "done" || raw.status === "dismissed"
        ? raw.status
        : "pending";
    const recorded = toolInputs.get(id);
    byId.set(id, {
      id,
      title,
      detail:
        typeof raw.detail === "string" && raw.detail.length > 0
          ? raw.detail
          : (recorded?.detail ?? null),
      rationale:
        typeof raw.rationale === "string" && raw.rationale.length > 0
          ? raw.rationale
          : (recorded?.rationale ?? null),
      status,
      turnId: (typeof raw.turnId === "string" ? raw.turnId : null) as TurnId | null,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : activity.createdAt,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : activity.createdAt,
    });
  }
  return [...byId.values()].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

export function derivePendingFollowups(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): FollowupState[] {
  return deriveFollowups(activities).filter((followup) => followup.status === "pending");
}

// Build the message that seeds a follow-up — either as a new turn in the
// current thread or as the opening message of a spun-off conversation.
//
// `extraContext` is what the user typed into the "Start custom…" dialog. It is
// labelled and placed last so the agent reads it as the operator's own
// amendment to the suggestion rather than as part of what the agent proposed —
// a follow-up is often too terse to act on, and the correction has to outrank
// the original wording when the two disagree.
export function buildFollowupPrompt(
  followup: Pick<FollowupState, "title" | "detail" | "rationale">,
  extraContext?: string,
): string {
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

export function buildFollowupThreadTitle(followup: Pick<FollowupState, "title">): string {
  return followup.title.trim();
}
