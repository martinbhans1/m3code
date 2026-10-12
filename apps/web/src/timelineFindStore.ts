/**
 * Hand-off from conversation search (Ctrl+K) to find-in-conversation: opening
 * a result that matched inside a message lands in that thread with the find
 * bar already open on the query, parked on the message that matched.
 *
 * In-memory only — a request is meant to be consumed by the very next render
 * of the thread it names.
 */
import { create } from "zustand";

export interface TimelineFindRequest {
  threadKey: string;
  query: string;
  /** Message the search matched; preferred over other rows containing the query. */
  messageId: string | null;
}

interface TimelineFindRequestState {
  request: TimelineFindRequest | null;
  requestFind: (request: TimelineFindRequest) => void;
  clearRequest: () => void;
}

export const useTimelineFindRequestStore = create<TimelineFindRequestState>()((set) => ({
  request: null,
  requestFind: (request) => set({ request }),
  clearRequest: () => set({ request: null }),
}));
