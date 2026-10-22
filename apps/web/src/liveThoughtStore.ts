/**
 * The agent's latest thought per thread while a turn runs — the one muted
 * line under "Working for …".
 *
 * Kept apart from the main thread store on purpose: it changes several times
 * a second while the agent thinks, and only the working row reads it, so the
 * timeline and everything else subscribed to thread state never re-renders
 * for it. Memory only; the server re-sends the current line on resubscribe.
 */
import type { OrchestrationThreadLiveThought, TurnId } from "@t3tools/contracts";
import { create } from "zustand";

interface LiveThoughtState {
  /** scoped thread key -> latest thought. */
  byThreadKey: Readonly<Record<string, OrchestrationThreadLiveThought>>;
  setLiveThought: (threadKey: string, liveThought: OrchestrationThreadLiveThought | null) => void;
}

export const useLiveThoughtStore = create<LiveThoughtState>()((set) => ({
  byThreadKey: {},
  setLiveThought: (threadKey, liveThought) =>
    set((state) => {
      const current = state.byThreadKey[threadKey];
      if (liveThought === null) {
        if (current === undefined) return state;
        const { [threadKey]: _removed, ...rest } = state.byThreadKey;
        return { byThreadKey: rest };
      }
      if (current?.text === liveThought.text && current.turnId === liveThought.turnId) {
        return state;
      }
      return { byThreadKey: { ...state.byThreadKey, [threadKey]: liveThought } };
    }),
}));

/** The thought to show for a thread's running turn, if it belongs to that turn. */
export function selectLiveThoughtText(
  state: Pick<LiveThoughtState, "byThreadKey">,
  threadKey: string | null,
  turnId: TurnId | null,
): string | null {
  if (threadKey === null || turnId === null) return null;
  const thought = state.byThreadKey[threadKey];
  return thought !== undefined && thought.turnId === turnId ? thought.text : null;
}

export function useLiveThoughtText(threadKey: string | null, turnId: TurnId | null): string | null {
  return useLiveThoughtStore((state) => selectLiveThoughtText(state, threadKey, turnId));
}
