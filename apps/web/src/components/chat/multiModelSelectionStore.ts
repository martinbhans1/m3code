import type { ModelSelection } from "@t3tools/contracts";
import { useCallback } from "react";
import { create } from "zustand";

import type { DraftId } from "../../composerDraftStore";

/**
 * Multi-model picks per new-thread draft. Kept outside the composer so the
 * picker, the workspace toolbar and the send path read one source, and so
 * the picks survive the chat view remounting while the user looks elsewhere.
 * Not persisted: a reload returns the draft to single-select.
 */
interface MultiModelSelectionStoreState {
  readonly byDraftId: Partial<Record<DraftId, ReadonlyArray<ModelSelection>>>;
  readonly set: (draftId: DraftId, selections: ReadonlyArray<ModelSelection> | null) => void;
}

export const useMultiModelSelectionStore = create<MultiModelSelectionStoreState>()((set) => ({
  byDraftId: {},
  set: (draftId, selections) =>
    set((state) => {
      if (selections === null || selections.length < 2) {
        if (!(draftId in state.byDraftId)) return state;
        const { [draftId]: _removed, ...byDraftId } = state.byDraftId;
        return { byDraftId };
      }
      return { byDraftId: { ...state.byDraftId, [draftId]: selections } };
    }),
}));

/**
 * The draft's multi-model picks (null in single-select, and always null
 * outside a new-thread draft) plus a setter scoped to that draft.
 */
export function useMultiModelSelection(draftId: DraftId | null) {
  const selections = useMultiModelSelectionStore((state) =>
    draftId ? (state.byDraftId[draftId] ?? null) : null,
  );
  const setStore = useMultiModelSelectionStore((state) => state.set);
  const setSelections = useCallback(
    (next: ReadonlyArray<ModelSelection> | null) => {
      if (draftId) setStore(draftId, next);
    },
    [draftId, setStore],
  );
  return [selections, setSelections] as const;
}
