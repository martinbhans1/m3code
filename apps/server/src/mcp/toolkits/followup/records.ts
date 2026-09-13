import {
  FOLLOWUP_ACTIVITY_KIND,
  OrchestrationFollowup,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Follow-ups ride the activity log rather than a thread column: each create or
 * status change appends another `turn.followup.suggested` activity carrying the
 * full record, and the latest one per id wins. Mirrors `deriveFollowups` on the
 * web side; kept separate because that lives in the web bundle.
 *
 * Shared by the in-thread followup toolkit (a conversation reading and closing
 * its own chips) and the orchestrator toolkit (doing the same across threads),
 * so the two surfaces cannot drift on what a follow-up's current state is.
 */
const decodeFollowup = Schema.decodeUnknownOption(OrchestrationFollowup);

/** The only activity kind follow-up state is derived from. */
export const FOLLOWUP_ACTIVITY_KINDS = [FOLLOWUP_ACTIVITY_KIND] as const;

/**
 * The current state of every follow-up in a thread, keyed by id.
 *
 * Whole records rather than a display projection, because closing one out means
 * writing the record back with only `status` and `updatedAt` changed — dropping
 * `turnId` or `implementationThreadId` on the way through would detach the
 * follow-up from its turn or forget the thread that was spun off for it.
 */
export function deriveFollowupRecords(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Map<string, OrchestrationFollowup> {
  const byId = new Map<string, OrchestrationFollowup>();

  // Latest per id wins, so fold in timestamp order rather than trusting the
  // order the snapshot happened to return them in.
  const followupActivities = activities
    .filter((activity) => activity.kind === FOLLOWUP_ACTIVITY_KIND)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));

  for (const activity of followupActivities) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    if (!payload) continue;
    const decoded = decodeFollowup(payload.followup);
    if (Option.isSome(decoded)) {
      byId.set(decoded.value.id, decoded.value);
    }
  }

  return byId;
}

// Field names the model actually uses for a follow-up's body, beyond the
// `detail` the tool declares. Kept in step with the same list in ClaudeAdapter,
// which reads them as calls come in; this side repairs the chips recorded
// before it did.
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
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const data =
      payload?.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : null;
    if (!data || typeof data.toolName !== "string" || !data.toolName.endsWith("suggest_followup")) {
      continue;
    }
    const result =
      data.result && typeof data.result === "object"
        ? (data.result as Record<string, unknown>)
        : null;
    const input =
      data.input && typeof data.input === "object" ? (data.input as Record<string, unknown>) : null;
    if (!result || typeof result.tool_use_id !== "string" || !input) continue;
    byToolUseId.set(result.tool_use_id, {
      detail: readAliasedString(input, FOLLOWUP_DETAIL_ALIASES),
      rationale: readAliasedString(input, FOLLOWUP_RATIONALE_ALIASES),
    });
  }
  return byToolUseId;
}

/** True when at least one record is missing text the tool call may still hold. */
export function needsFollowupDetailRepair(
  records: ReadonlyMap<string, OrchestrationFollowup>,
): boolean {
  for (const followup of records.values()) {
    if (followup.detail === null) return true;
  }
  return false;
}

/**
 * Fill in details that were dropped on the way in, from the tool calls that
 * still hold them. Returns the same map when there is nothing to repair, so the
 * common case — every follow-up recorded with its own detail — costs a scan and
 * no allocation.
 */
export function repairFollowupDetails(
  records: Map<string, OrchestrationFollowup>,
  toolCallActivities: ReadonlyArray<OrchestrationThreadActivity>,
): Map<string, OrchestrationFollowup> {
  if (!needsFollowupDetailRepair(records)) return records;
  const bodies = collectFollowupToolCallBodies(toolCallActivities);
  if (bodies.size === 0) return records;
  for (const [id, followup] of records) {
    if (followup.detail !== null) continue;
    const body = bodies.get(id);
    if (!body || body.detail === null) continue;
    records.set(id, {
      ...followup,
      detail: body.detail,
      rationale: followup.rationale ?? body.rationale,
    });
  }
  return records;
}

export function derivePendingFollowups(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Array<{
  followupId: string;
  title: string;
  detail: string | null;
  rationale: string | null;
  createdAt: string;
}> {
  return pendingFollowupsFromRecords(deriveFollowupRecords(activities));
}

/** The pending half of an already-derived (and possibly repaired) record set. */
export function pendingFollowupsFromRecords(
  records: ReadonlyMap<string, OrchestrationFollowup>,
): Array<{
  followupId: string;
  title: string;
  detail: string | null;
  rationale: string | null;
  createdAt: string;
}> {
  return [...records.values()]
    .filter((followup) => followup.status === "pending")
    .map((followup) => ({
      followupId: followup.id,
      title: followup.title,
      detail: followup.detail,
      rationale: followup.rationale,
      createdAt: followup.createdAt,
    }))
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * Coarse state of the conversation a follow-up was spun off into, so the agent
 * reading its own chips can say whether that work has actually started, is
 * parked waiting on the user, or has already finished.
 *
 * Deliberately simpler than the orchestrator's `summarizeThread`: this answers
 * "did anything come of it", not "what is that thread doing right now", and it
 * has to be derivable from a shell row alone.
 */
export type SpunOffThreadState =
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "failed"
  | "interrupted"
  | "completed"
  | "idle";

export function describeThreadState(thread: OrchestrationThreadShell): SpunOffThreadState {
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "running";
  }
  if (thread.latestTurn?.state === "running") return "running";
  // Blocked states outrank the finished turn that produced them: a thread whose
  // last turn "completed" while an approval is still open is waiting, not done.
  if (thread.hasPendingApprovals) return "waiting_for_approval";
  if (thread.hasPendingUserInput) return "waiting_for_input";
  if (thread.latestTurn === null) return "idle";
  if (thread.latestTurn.state === "error") return "failed";
  if (thread.latestTurn.state === "interrupted") return "interrupted";
  return "completed";
}
