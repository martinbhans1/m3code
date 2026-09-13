/**
 * threadShellSummary - The per-thread counts the sidebar and the orchestrator
 * read without opening a conversation: pending approvals, unanswered questions,
 * open follow-ups, handoff links, when the user last wrote, and whether a
 * proposed plan is waiting to be acted on.
 *
 * Two things live here together on purpose. The derivations, which are
 * unchanged from when they sat in the projection pipeline. And the rule for
 * which events can move which part, which is what lets the projection
 * recompute one part from one table instead of reloading the whole
 * conversation for every event. Keeping the activity kinds a derivation reads
 * next to the derivation is what stops the two drifting apart: add a kind to a
 * derivation below without adding it to `SHELL_SUMMARY_ACTIVITY_KINDS` and the
 * summary silently stops seeing it.
 */
import {
  ApprovalRequestId,
  FOLLOWUP_ACTIVITY_KIND,
  HANDOFF_ACTIVITY_KIND,
  type OrchestrationEvent,
  ThreadId,
} from "@t3tools/contracts";

import type { ProjectionThreadActivity } from "../persistence/Services/ProjectionThreadActivities.ts";
import type { ProjectionThreadProposedPlan } from "../persistence/Services/ProjectionThreadProposedPlans.ts";

const USER_INPUT_ACTIVITY_KINDS = [
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
] as const;

/**
 * Every activity kind a derivation in this module reads. An activity of any
 * other kind cannot change the summary, which is nearly all of them: tool
 * calls, file changes, context-window updates and checkpoints are the bulk of
 * a conversation's history.
 */
export const SHELL_SUMMARY_ACTIVITY_KINDS: ReadonlyArray<string> = [
  ...USER_INPUT_ACTIVITY_KINDS,
  FOLLOWUP_ACTIVITY_KIND,
  HANDOFF_ACTIVITY_KIND,
];

const SHELL_SUMMARY_ACTIVITY_KIND_SET: ReadonlySet<string> = new Set(SHELL_SUMMARY_ACTIVITY_KINDS);

/**
 * Activity kinds the pending-approvals projection writes on. Any other activity
 * leaves that table - and so the pending approval count - untouched.
 */
const PENDING_APPROVAL_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
]);

/** Which parts of the summary an event can move, one flag per source table. */
export interface ShellSummaryScope {
  /** `projection_thread_messages` -> when the user last wrote. */
  readonly latestUserMessage: boolean;
  /** `projection_pending_approvals` -> pending approval count. */
  readonly pendingApprovals: boolean;
  /** `projection_thread_activities` -> questions, follow-ups, handoffs. */
  readonly activities: boolean;
  /** `projection_thread_proposed_plans` plus the latest turn -> actionable plan. */
  readonly proposedPlan: boolean;
}

export const FULL_SHELL_SUMMARY_SCOPE: ShellSummaryScope = {
  latestUserMessage: true,
  pendingApprovals: true,
  activities: true,
  proposedPlan: true,
};

const EMPTY_SHELL_SUMMARY_SCOPE: ShellSummaryScope = {
  latestUserMessage: false,
  pendingApprovals: false,
  activities: false,
  proposedPlan: false,
};

/**
 * The parts of the summary a projected event can change.
 *
 * Derived from which projectors write on which events - the thread projector
 * runs last, after every other table has already absorbed the event:
 *
 * - messages change on `thread.message-sent` (and revert)
 * - proposed plans change on `thread.proposed-plan-upserted` (and revert)
 * - activities change on `thread.activity-appended` (and revert)
 * - pending approvals change on three approval activity kinds and
 *   `thread.approval-response-requested`
 * - the latest turn moves on `thread.session-set` and
 *   `thread.turn-diff-completed` (and revert), which is what the actionable plan
 *   is measured against
 *
 * Anything this does not recognise gets a full recompute, so a new caller is
 * slow rather than wrong.
 */
export function shellSummaryScopeForEvent(
  event: OrchestrationEvent,
  context?: { readonly latestTurnIdChanged: boolean },
): ShellSummaryScope {
  switch (event.type) {
    case "thread.message-sent":
      return { ...EMPTY_SHELL_SUMMARY_SCOPE, latestUserMessage: true };
    case "thread.proposed-plan-upserted":
      return { ...EMPTY_SHELL_SUMMARY_SCOPE, proposedPlan: true };
    case "thread.activity-appended":
      return {
        ...EMPTY_SHELL_SUMMARY_SCOPE,
        activities: SHELL_SUMMARY_ACTIVITY_KIND_SET.has(event.payload.activity.kind),
        pendingApprovals: PENDING_APPROVAL_ACTIVITY_KINDS.has(event.payload.activity.kind),
      };
    case "thread.approval-response-requested":
      return { ...EMPTY_SHELL_SUMMARY_SCOPE, pendingApprovals: true };
    case "thread.user-input-response-requested":
      // No projector writes a summary source for this event; the answer lands
      // later as its own `user-input.resolved` activity.
      return EMPTY_SHELL_SUMMARY_SCOPE;
    case "thread.session-set":
    case "thread.turn-diff-completed":
      return {
        ...EMPTY_SHELL_SUMMARY_SCOPE,
        proposedPlan: context?.latestTurnIdChanged ?? true,
      };
    default:
      // Includes `thread.reverted`, which rewrites messages, plans and activities.
      return FULL_SHELL_SUMMARY_SCOPE;
  }
}

export interface ThreadShellActivitySummary {
  readonly pendingUserInputCount: number;
  readonly pendingFollowupCount: number;
  readonly handoffThreadId: ThreadId | null;
  readonly sourceThreadId: ThreadId | null;
}

/**
 * Everything the summary derives from activities, in one pass over whichever
 * rows it is handed. Rows of kinds outside `SHELL_SUMMARY_ACTIVITY_KINDS` are
 * ignored by every derivation, so handing it the whole history and handing it
 * only those kinds give the same answer.
 */
export function deriveThreadShellActivitySummary(
  activities: ReadonlyArray<ProjectionThreadActivity>,
): ThreadShellActivitySummary {
  const { handoffThreadId, sourceThreadId } = deriveHandoffThreadIdsFromActivities(activities);
  return {
    pendingUserInputCount: derivePendingUserInputCountFromActivities(activities),
    pendingFollowupCount: derivePendingFollowupCountFromActivities(activities),
    handoffThreadId,
    sourceThreadId,
  };
}

export function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.make(requestId) : null;
}

export function derivePendingUserInputCountFromActivities(
  activities: ReadonlyArray<ProjectionThreadActivity>,
): number {
  const openRequestIds = new Set<string>();
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.activityId.localeCompare(right.activityId),
  );

  for (const activity of ordered) {
    const requestId = extractActivityRequestId(activity.payload);
    if (requestId === null) {
      continue;
    }
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;

    if (activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
      continue;
    }

    if (activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      detail !== null &&
      (detail.includes("stale pending user-input request") ||
        detail.includes("unknown pending user-input request") ||
        detail.includes("unknown pending user input request") ||
        detail.includes("unknown pending codex user input request"))
    ) {
      openRequestIds.delete(requestId);
    }
  }

  return openRequestIds.size;
}

/**
 * Agent-suggested follow-ups are event-sourced the same way the web client
 * reads them (see deriveFollowups): each create/update appends another
 * turn.followup.suggested activity carrying the whole record, and the latest
 * activity per follow-up id wins. Anything not explicitly resolved counts as
 * still pending.
 */
export function derivePendingFollowupCountFromActivities(
  activities: ReadonlyArray<ProjectionThreadActivity>,
): number {
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.activityId.localeCompare(right.activityId),
  );

  const statusByFollowupId = new Map<string, string>();
  for (const activity of ordered) {
    if (activity.kind !== FOLLOWUP_ACTIVITY_KIND) {
      continue;
    }
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const followup =
      payload?.followup && typeof payload.followup === "object"
        ? (payload.followup as Record<string, unknown>)
        : null;
    const followupId = typeof followup?.id === "string" ? followup.id : null;
    if (followupId === null || followupId.length === 0) {
      continue;
    }
    statusByFollowupId.set(
      followupId,
      typeof followup?.status === "string" ? followup.status : "pending",
    );
  }

  let pending = 0;
  for (const status of statusByFollowupId.values()) {
    if (status === "pending") {
      pending += 1;
    }
  }
  return pending;
}

/**
 * Handoffs are event-sourced the same way follow-ups are: each one appends a
 * thread.handoff activity carrying the whole record, and the latest activity per
 * direction wins. Mirrors deriveHandoffs on the web side — keep the two in sync.
 */
export function deriveHandoffThreadIdsFromActivities(
  activities: ReadonlyArray<ProjectionThreadActivity>,
): { readonly handoffThreadId: ThreadId | null; readonly sourceThreadId: ThreadId | null } {
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.activityId.localeCompare(right.activityId),
  );

  let handoffThreadId: ThreadId | null = null;
  let sourceThreadId: ThreadId | null = null;
  for (const activity of ordered) {
    if (activity.kind !== HANDOFF_ACTIVITY_KIND) {
      continue;
    }
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const handoff =
      payload?.handoff && typeof payload.handoff === "object"
        ? (payload.handoff as Record<string, unknown>)
        : null;
    const counterpartThreadId =
      typeof handoff?.counterpartThreadId === "string" ? handoff.counterpartThreadId : null;
    if (counterpartThreadId === null || counterpartThreadId.length === 0) {
      continue;
    }
    if (handoff?.direction === "continuedIn") {
      handoffThreadId = ThreadId.make(counterpartThreadId);
    } else if (handoff?.direction === "spunOffFrom") {
      sourceThreadId = ThreadId.make(counterpartThreadId);
    }
  }

  return { handoffThreadId, sourceThreadId };
}

export function deriveHasActionableProposedPlan(input: {
  readonly latestTurnId: string | null;
  readonly proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>;
}): boolean {
  const sorted = [...input.proposedPlans].toSorted(
    (left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) || left.planId.localeCompare(right.planId),
  );

  let latestForTurn: ProjectionThreadProposedPlan | null = null;
  if (input.latestTurnId !== null) {
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const plan = sorted[index];
      if (plan?.turnId === input.latestTurnId) {
        latestForTurn = plan;
        break;
      }
    }
  }
  if (latestForTurn !== null) {
    return latestForTurn.implementedAt === null;
  }

  const latestPlan = sorted.at(-1) ?? null;
  return latestPlan !== null && latestPlan.implementedAt === null;
}
