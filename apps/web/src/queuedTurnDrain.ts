import type { OrchestrationLatestTurnState, OrchestrationSessionStatus } from "@t3tools/contracts";

import type { QueuedTurn } from "./queuedTurnStore";

/**
 * How long a thread is left alone after a queued turn was handed to the server.
 *
 * The projection that says "this thread is running again" arrives over the
 * socket a moment after the dispatch resolves, so without a pause the next
 * queued turn would be dispatched into the gap and land as a steer. The window
 * is deliberately short and self-clearing: an earlier design waited for the
 * running projection and nothing else, which wedged the whole queue forever
 * whenever that projection was missed.
 */
export const QUEUED_TURN_DISPATCH_GRACE_MS = 10_000;

/** A thread's dispatch state, as the drainer last left it. */
export type QueuedTurnDispatchGuard =
  | { readonly kind: "in-flight" }
  | { readonly kind: "dispatched"; readonly at: number };

export interface QueuedTurnDrainCandidate {
  readonly key: string;
  /** Head of this thread's queue; only ever the first entry. */
  readonly turn: QueuedTurn;
  readonly sessionStatus: OrchestrationSessionStatus | null;
  readonly latestTurnState: OrchestrationLatestTurnState | null;
  readonly threadArchived: boolean;
  readonly transportConnected: boolean;
}

/**
 * Whether a thread can accept a new turn right now.
 *
 * Anything that is not mid-turn qualifies, including a thread whose provider
 * session was reaped for inactivity ("stopped"/"idle"). Sending to one of those
 * starts a fresh session, which is exactly what typing a message into an idle
 * conversation does — gating the queue on a live session is what left messages
 * parked for days.
 */
export function isThreadAcceptingQueuedTurn(input: {
  readonly sessionStatus: OrchestrationSessionStatus | null;
  readonly latestTurnState: OrchestrationLatestTurnState | null;
}): boolean {
  if (input.sessionStatus === "running" || input.sessionStatus === "starting") return false;
  return input.latestTurnState !== "running";
}

/**
 * Picks at most one queued turn per thread to hand to the server.
 *
 * Every thread with a queue is considered, not just the one on screen: which
 * conversation the user happens to be looking at has nothing to do with whether
 * a message they queued should go out.
 */
export function selectQueuedTurnsToDispatch(input: {
  readonly candidates: ReadonlyArray<QueuedTurnDrainCandidate>;
  readonly guards: ReadonlyMap<string, QueuedTurnDispatchGuard>;
  readonly now: number;
}): ReadonlyArray<QueuedTurnDrainCandidate> {
  return input.candidates.filter((candidate) => {
    if (candidate.turn.status !== "queued") return false;
    if (candidate.threadArchived) return false;
    if (!candidate.transportConnected) return false;
    if (!isThreadAcceptingQueuedTurn(candidate)) return false;
    const guard = input.guards.get(candidate.key);
    if (guard?.kind === "in-flight") return false;
    if (guard?.kind === "dispatched" && input.now - guard.at < QUEUED_TURN_DISPATCH_GRACE_MS) {
      return false;
    }
    return true;
  });
}
