import { describe, expect, it } from "vite-plus/test";

import {
  canonicalizeThreadTags,
  findMatchingThreadTag,
  mergeThreadTagVocabularies,
  normalizeThreadTagName,
  threadMatchesListFilter,
} from "./threadTags.ts";

const vocabulary = [
  { name: "tickets", description: "Support tickets" },
  { name: "opportunity-detail", description: "The single-opportunity page" },
  { name: "activities", description: "Activity log" },
];

describe("normalizeThreadTagName", () => {
  it("turns any spelling into one kebab-case slug", () => {
    expect(normalizeThreadTagName("  Opportunity Detail ")).toBe("opportunity-detail");
    expect(normalizeThreadTagName("opportunity_detail")).toBe("opportunity-detail");
    expect(normalizeThreadTagName("Tickets!")).toBe("tickets");
    expect(normalizeThreadTagName("---")).toBe("");
  });
});

describe("findMatchingThreadTag", () => {
  it("treats separators and a plural as the same tag", () => {
    expect(findMatchingThreadTag(vocabulary, "Ticket")?.name).toBe("tickets");
    expect(findMatchingThreadTag(vocabulary, "opportunitydetail")?.name).toBe("opportunity-detail");
    expect(findMatchingThreadTag(vocabulary, "activity")?.name).toBe("activities");
  });

  it("does not match a different area", () => {
    expect(findMatchingThreadTag(vocabulary, "support")).toBeUndefined();
    expect(findMatchingThreadTag(vocabulary, "")).toBeUndefined();
  });
});

describe("canonicalizeThreadTags", () => {
  it("maps variants onto the vocabulary and reports the rest", () => {
    expect(canonicalizeThreadTags(vocabulary, ["Ticket", "tickets", "support"])).toEqual({
      tags: ["tickets"],
      unknown: ["support"],
    });
  });
});

describe("threadMatchesListFilter", () => {
  const open = { doneAt: null, tags: ["tickets"] };
  const done = { doneAt: "2026-11-11T10:00:00.000Z", tags: ["activities"] };

  it("hides completed threads only when asked", () => {
    expect(threadMatchesListFilter(done, { hideCompleted: true, selectedTags: [] })).toBe(false);
    expect(threadMatchesListFilter(done, { hideCompleted: false, selectedTags: [] })).toBe(true);
  });

  it("keeps threads carrying any selected tag", () => {
    const filter = { hideCompleted: false, selectedTags: ["tickets", "imports"] };
    expect(threadMatchesListFilter(open, filter)).toBe(true);
    expect(threadMatchesListFilter(done, filter)).toBe(false);
  });
});

describe("mergeThreadTagVocabularies", () => {
  it("deduplicates by name and sorts", () => {
    expect(
      mergeThreadTagVocabularies([[vocabulary[0]!], [vocabulary[0]!, vocabulary[2]!]]).map(
        (tag) => tag.name,
      ),
    ).toEqual(["activities", "tickets"]);
  });
});
