import { ProjectId, ThreadId, type OrchestrationThreadSearchResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildConversationSearchChunks,
  buildFtsQuery,
  mergeHybridThreadSearchResults,
  relaxFtsQuery,
} from "./logic.ts";

const result = (
  threadId: string,
  matchKind: OrchestrationThreadSearchResult["matchKind"],
  score: number,
): OrchestrationThreadSearchResult => ({
  threadId: ThreadId.make(threadId),
  projectId: ProjectId.make("project-1"),
  title: threadId,
  projectTitle: "Deal Journey",
  branch: null,
  archivedAt: null,
  updatedAt: "2026-08-05T00:00:00.000Z",
  snippet: null,
  matchedRole: null,
  matchKind,
  score,
});

describe("conversation search logic", () => {
  it("builds safe Unicode queries, prefix-matching only the word still being typed", () => {
    expect(buildFtsQuery("  Visma NXT — visma!  ")).toBe('"visma"* AND "nxt"');
    expect(buildFtsQuery("***")).toBeNull();
    // Short trailing tokens are not worth a prefix expansion.
    expect(buildFtsQuery("visma nxt")).toBe('"visma" AND "nxt"');
  });

  it("drops stopwords so a dictated question does not scan the whole index", () => {
    // Every dropped term here is one that would otherwise be prefix-expanded
    // across most of the vocabulary.
    expect(buildFtsQuery("the one where we were fixing the email templates")).toBe(
      '"fixing" AND "email" AND "templates"*',
    );
    // Nothing discriminating left: the caller skips the content index entirely
    // rather than scanning it to return arbitrary rows.
    expect(buildFtsQuery("what is it")).toBeNull();
    expect(buildFtsQuery("the")).toBeNull();
  });

  it("keeps the word being typed even when the cap is full", () => {
    // "quest" is the shortest surviving term, so a pure longest-first cap would
    // drop it — and it is the only one that would have been prefix-matched, so
    // dropping it searches for everything except what the user is typing.
    const built = buildFtsQuery("orchestrator pagination sections threads offset limit quest");
    expect(built).toContain('"quest"*');
    expect(built?.split(" AND ")).toHaveLength(6);
  });

  it("caps term count, keeping the most selective terms in the user's order", () => {
    // "pagination"/"orchestrator"/"threads"/"offset"/"limit"/"list" survive;
    // "for" is a stopword and "list" is the shortest, so it is what the cap drops.
    expect(buildFtsQuery("orchestrator pagination limit offset for list threads seven")).toBe(
      '"orchestrator" AND "pagination" AND "limit" AND "offset" AND "threads" AND "seven"*',
    );
  });

  it("relaxes an all-terms query to any-term, and leaves a single term alone", () => {
    const strict = buildFtsQuery("cosmos starfield background");
    expect(strict).toBe('"cosmos" AND "starfield" AND "background"*');
    expect(relaxFtsQuery(strict!)).toBe('"cosmos" OR "starfield" OR "background"*');
    // One term is already as loose as it gets; null tells the caller not to
    // spend a second query re-running what it just ran.
    expect(relaxFtsQuery('"telavox"*')).toBeNull();
  });

  it("chunks provider-neutral conversation text with useful metadata", () => {
    const chunks = buildConversationSearchChunks([
      {
        threadId: "thread-1",
        title: "Sprint cleanup",
        projectTitle: "Deal Journey",
        branch: "fix/nxt",
        messageId: "message-1",
        role: "user",
        text: "Fix the Visma NXT sprint tasks",
      },
      {
        threadId: "thread-1",
        title: "Sprint cleanup",
        projectTitle: "Deal Journey",
        branch: "fix/nxt",
        messageId: "message-2",
        role: "assistant",
        text: "I updated the task projection.",
      },
    ]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("Title: Sprint cleanup");
    expect(chunks[0]?.text).toContain("Project: Deal Journey");
    expect(chunks[0]?.text).toContain("[User] Fix the Visma NXT sprint tasks");
    expect(chunks[0]?.text).toContain("[Assistant] I updated the task projection.");
  });

  it("never lets partial keyword matches displace a semantic hit", () => {
    // The relaxed pass returns matches by the dozen, so a loose band that merely
    // interleaves with the semantic one still crowds it out. These constants
    // mirror ConversationSearch's bands; if they drift back together, the
    // "described from memory" search silently starts answering with whichever
    // forty threads happened to share one word.
    const looseTop = 150 + 80 + 25;
    const weakestSemantic = 0.52 * 500;
    const loose = Array.from({ length: 40 }, (_, index) =>
      result(`noise-${index}`, "content-loose", looseTop - index),
    );

    const merged = mergeHybridThreadSearchResults({
      lexical: loose,
      semantic: [result("right-thread", "semantic", weakestSemantic)],
      limit: 10,
    });
    expect(merged[0]?.threadId).toBe(ThreadId.make("right-thread"));

    // But a loose match is still better than telling the user nothing exists.
    const nothingBetter = mergeHybridThreadSearchResults({
      lexical: loose,
      semantic: [],
      limit: 10,
    });
    expect(nothingBetter).toHaveLength(10);
  });

  it("keeps lexical matches ahead while boosting threads found by both indexes", () => {
    const merged = mergeHybridThreadSearchResults({
      lexical: [result("lexical", "content", 700)],
      semantic: [result("lexical", "semantic", 300), result("semantic", "semantic", 400)],
      limit: 10,
    });

    expect(merged.map((entry) => entry.threadId)).toEqual([
      ThreadId.make("lexical"),
      ThreadId.make("semantic"),
    ]);
    expect(merged[0]?.matchKind).toBe("hybrid");
  });
});
