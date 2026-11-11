import { describe, expect, it } from "vite-plus/test";

import {
  canonicalizeThreadTags,
  findMatchingThreadTag,
  mergeThreadTagVocabularies,
  normalizeThreadTagName,
  planThreadTagEdit,
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

describe("planThreadTagEdit", () => {
  const threads = [{ tags: ["support", "activities"] }, { tags: ["tickets"] }, { tags: [] }];
  const withSynonym = [...vocabulary, { name: "support", description: "Customer support" }];

  it("merges a synonym into the existing tag and moves its threads", () => {
    const plan = planThreadTagEdit(withSynonym, threads, {
      kind: "rename",
      from: "support",
      to: "Tickets",
    });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.mergedInto).toBe("tickets");
    expect(plan.vocabulary.map((tag) => tag.name)).toEqual([
      "tickets",
      "opportunity-detail",
      "activities",
    ]);
    expect([...plan.threadTags]).toEqual([[0, ["tickets", "activities"]]]);
  });

  it("renames in place when the new name is free", () => {
    const plan = planThreadTagEdit(withSynonym, threads, {
      kind: "rename",
      from: "support",
      to: "Help Desk",
    });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.mergedInto).toBeNull();
    expect(plan.vocabulary.at(-1)).toEqual({ name: "help-desk", description: "Customer support" });
    expect(plan.threadTags.get(0)).toEqual(["help-desk", "activities"]);
  });

  it("deletes a tag from the vocabulary and from its threads", () => {
    const plan = planThreadTagEdit(withSynonym, threads, { kind: "delete", name: "tickets" });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.vocabulary.some((tag) => tag.name === "tickets")).toBe(false);
    expect([...plan.threadTags]).toEqual([[1, []]]);
  });
});
