/**
 * Tracks, per thread, which plan/turn the Tasks (plan) sidebar has already been
 * auto-opened for. Persisted to localStorage so the "auto-open the plan sidebar"
 * setting opens a given plan/turn at most ONCE — after that, whether the panel
 * is open is the user's decision. Closing it (via any control) sticks across
 * conversation switches and reloads, because we never re-auto-open the same
 * turn. A genuinely new turn (new plan) re-triggers the one-time auto-open.
 *
 * Keyed by scoped thread key, so the decision is local to each conversation and
 * never leaks across threads.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

interface PlanSidebarAutoOpenState {
  /** scoped thread key -> the plan/turn key that was already auto-opened. */
  openedTurnByThread: Record<string, string>;
  markAutoOpened: (threadKey: string, turnKey: string) => void;
}

export const usePlanSidebarAutoOpenStore = create<PlanSidebarAutoOpenState>()(
  persist(
    (set) => ({
      openedTurnByThread: {},
      markAutoOpened: (threadKey, turnKey) =>
        set((state) =>
          state.openedTurnByThread[threadKey] === turnKey
            ? state
            : {
                openedTurnByThread: { ...state.openedTurnByThread, [threadKey]: turnKey },
              },
        ),
    }),
    {
      name: "t3code:plan-sidebar-auto-open:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);
