import type { ClientOrchestrationCommand, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime";
import { create } from "zustand";

type TurnStartCommand = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;

export interface QueuedTurn {
  readonly id: string;
  readonly threadRef: ScopedThreadRef;
  readonly displayText: string;
  readonly command: TurnStartCommand;
  readonly status: "queued" | "sending" | "failed";
  readonly error: string | null;
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

export const useQueuedTurnStore = create<QueuedTurnStoreState>()((set) => ({
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
}));
