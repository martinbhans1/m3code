import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { findTimelineMatches, stepTimelineFindIndex } from "./timelineFind";

function message(id: string, role: "user" | "assistant" | "system", text: string) {
  return {
    kind: "message",
    id,
    createdAt: "2026-10-12T00:00:00.000Z",
    message: {
      id: MessageId.make(id),
      role,
      text,
      createdAt: "2026-10-12T00:00:00.000Z",
      streaming: false,
    },
    durationStart: "2026-10-12T00:00:00.000Z",
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  } satisfies MessagesTimelineRow;
}

const rows: MessagesTimelineRow[] = [
  message("a", "user", "How do we handle the Deployment?"),
  { kind: "work", id: "w", createdAt: "2026-10-12T00:00:00.000Z", groupedEntries: [] },
  message("b", "assistant", "Nothing to see"),
  message("c", "system", "deployment notice"),
  message("d", "assistant", "The **deployment** runs on push"),
];

describe("findTimelineMatches", () => {
  it("returns user and assistant rows containing the query, case-insensitively", () => {
    expect(findTimelineMatches(rows, "  DEPLOYMENT ")).toEqual([
      { rowId: "a", rowIndex: 0 },
      { rowId: "d", rowIndex: 4 },
    ]);
  });

  it("matches a phrase running across markdown emphasis", () => {
    expect(findTimelineMatches(rows, "deployment runs")).toEqual([{ rowId: "d", rowIndex: 4 }]);
  });

  it("matches nothing for a blank query", () => {
    expect(findTimelineMatches(rows, "   ")).toEqual([]);
  });
});

describe("stepTimelineFindIndex", () => {
  it("wraps in both directions", () => {
    expect(stepTimelineFindIndex(2, 3, 1)).toBe(0);
    expect(stepTimelineFindIndex(0, 3, -1)).toBe(2);
  });

  it("starts from either end when nothing is selected", () => {
    expect(stepTimelineFindIndex(-1, 3, 1)).toBe(0);
    expect(stepTimelineFindIndex(-1, 3, -1)).toBe(2);
    expect(stepTimelineFindIndex(-1, 0, 1)).toBe(-1);
  });
});
