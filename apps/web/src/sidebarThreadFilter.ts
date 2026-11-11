/**
 * The sidebar's Filter menu: hide completed conversations, and narrow a
 * project's list to the tags the user picked. Persisted so the list looks the
 * same after a reload. Tag selections are per project (keyed by the sidebar's
 * logical project key) because each project has its own vocabulary.
 *
 * The matching rule itself lives in `@t3tools/shared/threadTags` so mobile
 * filters identically.
 */
import type { ThreadListFilter } from "@t3tools/shared/threadTags";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

interface SidebarThreadFilterState {
  /** Completed conversations are hidden unless the user turns this off. */
  hideCompleted: boolean;
  /** project key -> tag names the list is narrowed to. Empty or absent = all. */
  selectedTagsByProject: Record<string, string[]>;
  setHideCompleted: (hideCompleted: boolean) => void;
  toggleTag: (projectKey: string, tag: string) => void;
  clearTags: () => void;
  /** Follow a rename or merge (`to` set) or a delete (`to` null) in the selection. */
  remapTag: (projectKey: string, from: string, to: string | null) => void;
}

const EMPTY_TAGS: readonly string[] = [];

export const useSidebarThreadFilterStore = create<SidebarThreadFilterState>()(
  persist(
    (set) => ({
      hideCompleted: true,
      selectedTagsByProject: {},
      setHideCompleted: (hideCompleted) => set({ hideCompleted }),
      toggleTag: (projectKey, tag) =>
        set((state) => {
          const selected = state.selectedTagsByProject[projectKey] ?? [];
          const next = selected.includes(tag)
            ? selected.filter((entry) => entry !== tag)
            : [...selected, tag];
          return { selectedTagsByProject: { ...state.selectedTagsByProject, [projectKey]: next } };
        }),
      clearTags: () => set({ selectedTagsByProject: {} }),
      remapTag: (projectKey, from, to) =>
        set((state) => {
          const selected = state.selectedTagsByProject[projectKey];
          if (!selected?.includes(from)) return state;
          const next = selected.filter((tag) => tag !== from);
          if (to !== null && !next.includes(to)) next.push(to);
          return { selectedTagsByProject: { ...state.selectedTagsByProject, [projectKey]: next } };
        }),
    }),
    {
      name: "m3code:sidebar-thread-filter:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);

/** The filter that applies to one project's list. Stable reference when nothing is selected. */
export function useProjectThreadListFilter(projectKey: string): ThreadListFilter {
  const hideCompleted = useSidebarThreadFilterStore((state) => state.hideCompleted);
  const selectedTags = useSidebarThreadFilterStore(
    (state) => state.selectedTagsByProject[projectKey] ?? EMPTY_TAGS,
  );
  return { hideCompleted, selectedTags };
}

/** How many filters are narrowing the list, for the badge on the Filter button. */
export function countActiveSidebarFilters(state: {
  readonly hideCompleted: boolean;
  readonly selectedTagsByProject: Record<string, readonly string[]>;
}): number {
  const tagCount = Object.values(state.selectedTagsByProject).reduce(
    (total, tags) => total + tags.length,
    0,
  );
  return (state.hideCompleted ? 1 : 0) + tagCount;
}
