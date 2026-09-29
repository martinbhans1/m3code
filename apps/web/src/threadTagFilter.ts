/**
 * Title-prefix tags for the sidebar project row. A conversation titled
 * "Dealy Dev — fix the importer" (em dash, en dash or "--") belongs to the
 * "Dealy Dev" tag. Tags shared by at least two conversations in a project show
 * as chips on the project row; clicking a chip hides or shows that group.
 * Conversations without a tag fall under "Other".
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const OTHER_THREAD_TAG_KEY = "__other__";
const MIN_THREADS_PER_TAG = 2;
const MAX_TAG_LENGTH = 32;
const MAX_TAGS = 4;
const TITLE_TAG_PATTERN = /^\s*([^—–]+?)\s*(?:—|–|--)\s*\S/;

export interface ThreadTag {
  key: string;
  label: string;
  count: number;
}

export function threadTitleTagKey(title: string): string | null {
  const match = TITLE_TAG_PATTERN.exec(title);
  const label = match?.[1]?.trim();
  if (!label || label.length > MAX_TAG_LENGTH) return null;
  return label.toLowerCase();
}

/** Tags worth a chip, most-used first, plus "Other" when anything is untagged. */
export function deriveThreadTags(titles: readonly string[]): ThreadTag[] {
  const byKey = new Map<string, ThreadTag>();
  for (const title of titles) {
    const key = threadTitleTagKey(title);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byKey.set(key, { key, label: TITLE_TAG_PATTERN.exec(title)![1]!.trim(), count: 1 });
    }
  }
  const tags = [...byKey.values()]
    .filter((tag) => tag.count >= MIN_THREADS_PER_TAG)
    .toSorted((a, b) => b.count - a.count)
    .slice(0, MAX_TAGS);
  if (tags.length === 0) return [];
  const tagKeys = new Set(tags.map((tag) => tag.key));
  const otherCount = titles.filter((title) => {
    const key = threadTitleTagKey(title);
    return key === null || !tagKeys.has(key);
  }).length;
  return otherCount > 0
    ? [...tags, { key: OTHER_THREAD_TAG_KEY, label: "Other", count: otherCount }]
    : tags;
}

/** Which chip a title falls under, given the chips on show. */
export function resolveThreadTag(title: string, tags: readonly ThreadTag[]): string {
  const key = threadTitleTagKey(title);
  return key !== null && tags.some((tag) => tag.key === key) ? key : OTHER_THREAD_TAG_KEY;
}

interface ThreadTagFilterState {
  /** project key -> tag keys the user switched off. */
  hiddenTagsByProject: Record<string, string[]>;
  toggleTag: (projectKey: string, tagKey: string) => void;
}

export const useThreadTagFilterStore = create<ThreadTagFilterState>()(
  persist(
    (set) => ({
      hiddenTagsByProject: {},
      toggleTag: (projectKey, tagKey) =>
        set((state) => {
          const hidden = state.hiddenTagsByProject[projectKey] ?? [];
          const next = hidden.includes(tagKey)
            ? hidden.filter((key) => key !== tagKey)
            : [...hidden, tagKey];
          return { hiddenTagsByProject: { ...state.hiddenTagsByProject, [projectKey]: next } };
        }),
    }),
    {
      name: "m3code:thread-tag-filter:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);
