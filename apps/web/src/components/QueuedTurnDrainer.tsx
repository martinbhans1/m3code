import { useEffect, useRef } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { readEnvironmentApi } from "../environmentApi";
import { usePrimaryEnvironmentId } from "../environments/primary/context";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime/catalog";
import {
  selectQueuedTurnsToDispatch,
  type QueuedTurnDispatchGuard,
  type QueuedTurnDrainCandidate,
} from "../queuedTurnDrain";
import { queuedTurnCommandForDispatch, useQueuedTurnStore } from "../queuedTurnStore";
import {
  getWsConnectionStatus,
  getWsConnectionUiState,
  useWsConnectionStatus,
} from "../rpc/wsConnectionState";
import { isTransportConnectionError } from "../rpc/transportError";
import { selectSidebarThreadSummaryByRef, useStore } from "../store";

/**
 * Store updates arrive in bursts while a turn streams; a queue only ever moves
 * when one ends. Coalescing keeps this off the hot path.
 */
const EVALUATION_COALESCE_MS = 200;

/**
 * Sends queued messages once their conversation is free — every conversation,
 * not just the one on screen.
 *
 * Queuing is client-side, so something has to notice that a turn ended and hand
 * the parked message over. That used to live inside the chat view, which meant
 * it only ran for the thread the user was looking at: queue a message, switch
 * conversations, and it sat there until you came back — and once the idle
 * sweeper closed the provider session, it sat there forever.
 */
export function QueuedTurnDrainer() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const wsConnectionStatus = useWsConnectionStatus();

  /**
   * Whether commands for an environment can reach a server right now. Saved
   * environments track their own connection; everything else rides the primary
   * WebSocket.
   */
  const isEnvironmentConnectedRef = useRef<(environmentId: EnvironmentId) => boolean>(() => false);
  isEnvironmentConnectedRef.current = (environmentId) => {
    const saved =
      environmentId === primaryEnvironmentId ? undefined : savedEnvironmentRegistry[environmentId];
    if (saved) {
      return savedEnvironmentRuntimeById[environmentId]?.connectionState === "connected";
    }
    return getWsConnectionUiState(getWsConnectionStatus()) === "connected";
  };

  const scheduleRef = useRef<() => void>(() => {});

  useEffect(() => {
    const guards = new Map<string, QueuedTurnDispatchGuard>();
    let pendingEvaluation: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const collect = (): ReadonlyArray<QueuedTurnDrainCandidate> => {
      const appState = useStore.getState();
      const candidates: QueuedTurnDrainCandidate[] = [];
      for (const [key, turns] of Object.entries(useQueuedTurnStore.getState().byThreadKey)) {
        const turn = turns[0];
        if (!turn) continue;
        const summary = selectSidebarThreadSummaryByRef(appState, turn.threadRef);
        // An unknown thread is one whose shell has not loaded yet (or was
        // deleted). Leave it queued rather than guessing it is idle.
        if (!summary) continue;
        candidates.push({
          key,
          turn,
          sessionStatus: summary.session?.orchestrationStatus ?? null,
          latestTurnState: summary.latestTurn?.state ?? null,
          threadArchived: summary.archivedAt !== null,
          transportConnected: isEnvironmentConnectedRef.current(turn.threadRef.environmentId),
        });
      }
      return candidates;
    };

    const evaluate = () => {
      if (disposed) return;
      const dispatchable = selectQueuedTurnsToDispatch({
        candidates: collect(),
        guards,
        now: Date.now(),
      });

      for (const candidate of dispatchable) {
        const api = readEnvironmentApi(candidate.turn.threadRef.environmentId);
        if (!api) continue;
        const { key, turn } = candidate;
        guards.set(key, { kind: "in-flight" });
        useQueuedTurnStore.getState().markSending(turn.threadRef, turn.id);
        void api.orchestration.dispatchCommand(queuedTurnCommandForDispatch(turn, new Date())).then(
          () => {
            guards.set(key, { kind: "dispatched", at: Date.now() });
            useQueuedTurnStore.getState().remove(turn.threadRef, turn.id);
          },
          (error: unknown) => {
            guards.delete(key);
            // Losing the connection mid-dispatch is not a failed message, just
            // a failed attempt: put it back in line for the next reconnect.
            // Anything else is a real rejection the user has to see and act on.
            if (isTransportConnectionError(error)) {
              useQueuedTurnStore.getState().retry(turn.threadRef, turn.id);
              return;
            }
            useQueuedTurnStore
              .getState()
              .markFailed(
                turn.threadRef,
                turn.id,
                error instanceof Error ? error.message : "Failed to send queued message.",
              );
          },
        );
      }
    };

    const schedule = () => {
      if (disposed || pendingEvaluation !== null) return;
      pendingEvaluation = setTimeout(() => {
        pendingEvaluation = null;
        evaluate();
      }, EVALUATION_COALESCE_MS);
    };
    scheduleRef.current = schedule;

    schedule();
    const unsubscribeStore = useStore.subscribe(schedule);
    const unsubscribeQueue = useQueuedTurnStore.subscribe(schedule);

    // A thread that goes quiet emits no further store updates, so the grace
    // window after a dispatch needs its own nudge to be re-examined.
    const interval = setInterval(schedule, 5_000);

    return () => {
      disposed = true;
      unsubscribeStore();
      unsubscribeQueue();
      clearInterval(interval);
      if (pendingEvaluation !== null) clearTimeout(pendingEvaluation);
    };
  }, []);

  // Reconnecting is the moment a queue held back by a dead socket can move.
  useEffect(() => {
    scheduleRef.current();
  }, [
    primaryEnvironmentId,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
    wsConnectionStatus,
  ]);

  return null;
}
