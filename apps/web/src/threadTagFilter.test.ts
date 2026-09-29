import { describe, expect, it } from "vite-plus/test";

import { deriveThreadTags, OTHER_THREAD_TAG_KEY, resolveThreadTag } from "./threadTagFilter";

describe("deriveThreadTags", () => {
  it("groups em dash, en dash and double-hyphen prefixes case-insensitively", () => {
    const tags = deriveThreadTags([
      "Dealy Dev — fix importer",
      "dealy dev -- tidy prompts",
      "Dealy Dev – new eval",
      "Fix login bug",
    ]);
    expect(tags).toEqual([
      { key: "dealy dev", label: "Dealy Dev", count: 3 },
      { key: OTHER_THREAD_TAG_KEY, label: "Other", count: 1 },
    ]);
  });

  it("ignores one-off prefixes and plain hyphens", () => {
    expect(deriveThreadTags(["Solo — one", "Fix - two", "Fix - three"])).toEqual([]);
  });

  it("files threads with a non-chip prefix under Other", () => {
    const tags = deriveThreadTags(["A — 1", "A — 2", "B — 1"]);
    expect(resolveThreadTag("B — 1", tags)).toBe(OTHER_THREAD_TAG_KEY);
    expect(resolveThreadTag("a -- 3", tags)).toBe("a");
  });
});
