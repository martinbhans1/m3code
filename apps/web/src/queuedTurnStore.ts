import type { ClientOrchestrationCommand, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

type TurnStartCommand = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;

export interface QueuedTurn {
  readonly id: string;
  readonly threadRef: ScopedThreadRef;
  readonly displayText: string;
  readonly command: TurnStartCommand;
  readonly status: "queued" | "sending" | "failed";
  readonly error: string | null;
}

export const QUEUED_TURN_STORAGE_KEY = "t3code:queued-turns:v1";

/**
 * Budget for a single persisted turn.
 *
 * Queued turns carry their attachments inline as data URLs, and a couple of
 * photos will happily exceed the whole localStorage quota. Oversized turns stay
 * in memory for the session rather than taking the entire queue down with a
 * failed write — the common case this exists for is a text message sent while
 * the socket was down, which is tiny.
 */
const MAX_PERSISTED_TURN_BYTES = 256 * 1024;

function isPersistableTurn(turn: QueuedTurn): boolean {
  try {
    return JSON.stringify(turn).length <= MAX_PERSISTED_TURN_BYTES;
  } catch {
    return false;
  }
}

/**
 * A turn that was mid-flight when the page went away has an unknown fate: the
 * server may or may not have accepted it. Restoring it as `failed` keeps it
 * visible and lets the user decide, rather than silently double-sending.
 */
function restoreTurnStatus(turn: QueuedTurn): QueuedTurn {
  return turn.status === "sending"
    ? { ...turn, status: "failed", error: "Interrupted before the send was confirmed." }
    : turn;
}

interface QueuedTurnStoreState {
  readonly byThreadKey: Record<string, ReadonlyArray<QueuedTurn>>;
  enqueue: (turn: QueuedTurn) => void;
  remove: (threadRef: ScopedThreadRef, id: string) => void;
  move: (threadRef: ScopedThreadRef, id: string, offset: -1 | 1) => void;
  markSending: (threadRef: ScopedThreadRef, id: string) => void;
  markFailed: (threadRef: ScopedThreadRef, id: string, error: string) => void;
  retry: (threadRef: ScopedThreadRef, id: string) => void;
}

function updateTurn(
  entries: ReadonlyArray<QueuedTurn>,
  id: string,
  update: (turn: QueuedTurn) => QueuedTurn,
): ReadonlyArray<QueuedTurn> {
  return entries.map((entry) => (entry.id === id ? update(entry) : entry));
}

const EMPTY_QUEUED_TURNS: ReadonlyArray<QueuedTurn> = [];

/**
 * Reads a thread's queued turns, returning a stable reference when there are none.
 *
 * zustand v5 hands the selector result straight to `useSyncExternalStore` and compares
 * with `Object.is`, so a selector that allocates a fresh `[]` for the empty case makes
 * every snapshot look changed and re-renders forever (React error #185).
 */
export function selectQueuedTurns(
  byThreadKey: Record<string, ReadonlyArray<QueuedTurn>>,
  threadKey: string | null,
): ReadonlyArray<QueuedTurn> {
  if (!threadKey) return EMPTY_QUEUED_TURNS;
  return byThreadKey[threadKey] ?? EMPTY_QUEUED_TURNS;
}

export const useQueuedTurnStore = create<QueuedTurnStoreState>()(
  persist<QueuedTurnStoreState>(
    (set) => ({
      byThreadKey: {},
      enqueue: (turn) =>
        set((state) => {
          const key = scopedThreadKey(turn.threadRef);
          return {
            byThreadKey: { ...state.byThreadKey, [key]: [...(state.byThreadKey[key] ?? []), turn] },
          };
        }),
      remove: (threadRef, id) =>
        set((state) => {
          const key = scopedThreadKey(threadRef);
          const nextEntries = (state.byThreadKey[key] ?? []).filter((entry) => entry.id !== id);
          const next = { ...state.byThreadKey };
          if (nextEntries.length === 0) delete next[key];
          else next[key] = nextEntries;
          return { byThreadKey: next };
        }),
      move: (threadRef, id, offset) =>
        set((state) => {
          const key = scopedThreadKey(threadRef);
          const entries = [...(state.byThreadKey[key] ?? [])];
          const index = entries.findIndex((entry) => entry.id === id);
          const nextIndex = index + offset;
          if (index < 0 || nextIndex < 0 || nextIndex >= entries.length) return state;
          const [entry] = entries.splice(index, 1);
          if (!entry) return state;
          entries.splice(nextIndex, 0, entry);
          return { byThreadKey: { ...state.byThreadKey, [key]: entries } };
        }),
      markSending: (threadRef, id) =>
        set((state) => {
          const key = scopedThreadKey(threadRef);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [key]: updateTurn(state.byThreadKey[key] ?? [], id, (turn) => ({
                ...turn,
                status: "sending",
                error: null,
              })),
            },
          };
        }),
      markFailed: (threadRef, id, error) =>
        set((state) => {
          const key = scopedThreadKey(threadRef);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [key]: updateTurn(state.byThreadKey[key] ?? [], id, (turn) => ({
                ...turn,
                status: "failed",
                error,
              })),
            },
          };
        }),
      retry: (threadRef, id) =>
        set((state) => {
          const key = scopedThreadKey(threadRef);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [key]: updateTurn(state.byThreadKey[key] ?? [], id, (turn) => ({
                ...turn,
                status: "queued",
                error: null,
              })),
            },
          };
        }),
    }),
    {
      name: QUEUED_TURN_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) =>
        ({
          ...state,
          byThreadKey: Object.fromEntries(
            Object.entries(state.byThreadKey)
              .map(([key, turns]) => [key, turns.filter(isPersistableTurn)] as const)
              .filter(([, turns]) => turns.length > 0),
          ),
        }) satisfies QueuedTurnStoreState,
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<QueuedTurnStoreState> | undefined;
        return {
          ...currentState,
          byThreadKey: Object.fromEntries(
            Object.entries(persisted?.byThreadKey ?? {}).map(
              ([key, turns]) => [key, turns.map(restoreTurnStatus)] as const,
            ),
          ),
        };
      },
    },
  ),
);
