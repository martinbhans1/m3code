import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { PendingUserInputDraftAnswer } from "./pendingUserInput";

export const PENDING_USER_INPUT_DRAFT_STORAGE_KEY = "t3code:pending-user-input-drafts:v1";

/**
 * Answering a set of questions is real work — options picked, and often a
 * typed-out answer of your own. Holding that in component state meant a trip to
 * another conversation threw it away and dropped you back on question one, so
 * the draft lives here instead: keyed by request, and persisted so an app
 * restart mid-questionnaire is survivable too.
 */
export interface PendingUserInputDraft {
  readonly answers: Record<string, PendingUserInputDraftAnswer>;
  /** `null` until the user moves off the question the panel opened on. */
  readonly questionIndex: number | null;
}

export const EMPTY_PENDING_USER_INPUT_DRAFT: PendingUserInputDraft = {
  answers: {},
  questionIndex: null,
};

/**
 * A request whose questions are never answered is never cleared, so cap how
 * many drafts we keep. Insertion order is oldest-first for string keys, and
 * rewriting an existing key keeps its place, so the tail is the recent set.
 */
const MAX_RETAINED_REQUESTS = 25;

function prune(
  byRequestId: Record<string, PendingUserInputDraft>,
): Record<string, PendingUserInputDraft> {
  const keys = Object.keys(byRequestId);
  if (keys.length <= MAX_RETAINED_REQUESTS) {
    return byRequestId;
  }

  const retained = keys.slice(keys.length - MAX_RETAINED_REQUESTS);
  return Object.fromEntries(retained.map((key) => [key, byRequestId[key]] as const)) as Record<
    string,
    PendingUserInputDraft
  >;
}

interface PendingUserInputDraftStoreState {
  readonly byRequestId: Record<string, PendingUserInputDraft>;
  setQuestionIndex: (requestId: string, questionIndex: number) => void;
  /**
   * `currentQuestionIndex` is the question the user is looking at. When no
   * place is recorded yet it gets pinned here: otherwise the panel keeps
   * showing "the first unanswered question", so the first click or keystroke
   * on question 1 would make it answered and jump straight to question 2.
   */
  updateAnswer: (
    requestId: string,
    questionId: string,
    update: (existing: PendingUserInputDraftAnswer | undefined) => PendingUserInputDraftAnswer,
    currentQuestionIndex?: number,
  ) => void;
  clear: (requestId: string) => void;
}

/**
 * Reads one request's draft, returning a stable reference when there is none.
 *
 * zustand v5 hands the selector result straight to `useSyncExternalStore` and
 * compares with `Object.is`, so a selector that allocates a fresh object for the
 * empty case re-renders forever.
 */
export function selectPendingUserInputDraft(
  byRequestId: Record<string, PendingUserInputDraft>,
  requestId: string | null,
): PendingUserInputDraft {
  if (!requestId) return EMPTY_PENDING_USER_INPUT_DRAFT;
  return byRequestId[requestId] ?? EMPTY_PENDING_USER_INPUT_DRAFT;
}

export const usePendingUserInputDraftStore = create<PendingUserInputDraftStoreState>()(
  persist<PendingUserInputDraftStoreState>(
    (set) => ({
      byRequestId: {},
      setQuestionIndex: (requestId, questionIndex) =>
        set((state) => {
          const existing = state.byRequestId[requestId] ?? EMPTY_PENDING_USER_INPUT_DRAFT;
          if (existing.questionIndex === questionIndex) return state;
          return {
            byRequestId: prune({
              ...state.byRequestId,
              [requestId]: { ...existing, questionIndex },
            }),
          };
        }),
      updateAnswer: (requestId, questionId, update, currentQuestionIndex) =>
        set((state) => {
          const existing = state.byRequestId[requestId] ?? EMPTY_PENDING_USER_INPUT_DRAFT;
          return {
            byRequestId: prune({
              ...state.byRequestId,
              [requestId]: {
                ...existing,
                questionIndex: existing.questionIndex ?? currentQuestionIndex ?? null,
                answers: {
                  ...existing.answers,
                  [questionId]: update(existing.answers[questionId]),
                },
              },
            }),
          };
        }),
      clear: (requestId) =>
        set((state) => {
          if (!(requestId in state.byRequestId)) return state;
          const next = { ...state.byRequestId };
          delete next[requestId];
          return { byRequestId: next };
        }),
    }),
    {
      name: PENDING_USER_INPUT_DRAFT_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => state,
    },
  ),
);
