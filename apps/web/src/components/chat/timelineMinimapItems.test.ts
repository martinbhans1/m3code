import { describe, expect, it } from "vite-plus/test";
import { MessageId } from "@t3tools/contracts";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  deriveTimelineMinimapItems,
  resolveTimelineMinimapCurrentIndex,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapHitStripWidth,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapPreview,
  resolveTimelineMinimapTopPercent,
} from "./timelineMinimapItems";

function rows(
  entries: ReadonlyArray<readonly ["user" | "assistant", string]>,
): MessagesTimelineRow[] {
  return entries.map(([role, text], index) => {
    const createdAt = new Date(index * 1000).toISOString();
    return {
      kind: "message",
      id: `message-${index}`,
      createdAt,
      message: { id: MessageId.make(`message-${index}`), role, text, createdAt, streaming: false },
      durationStart: createdAt,
      showAssistantMeta: false,
      showAssistantCopyButton: false,
      assistantCopyStreaming: false,
    } as MessagesTimelineRow;
  });
}

describe("timeline minimap items", () => {
  it("previews the last reply before the next prompt and keeps jump targets", () => {
    const source = rows([
      ["user", "  Inspect\n this  "],
      ["assistant", "Working"],
      ["assistant", " Done\t now "],
      ["user", "Next"],
      ["assistant", "Second answer"],
    ]);
    const items = deriveTimelineMinimapItems(source);
    expect(items).toHaveLength(2);
    expect(resolveTimelineMinimapPreview(items[0]!)).toEqual({
      ...items[0],
      userText: "Inspect this",
      assistantText: "Done now",
    });
    expect(source[items[1]!.rowIndex]!.id).toBe(items[1]!.id);
    expect(resolveTimelineMinimapPreview(items[1]!)?.assistantText).toBe("Second answer");
  });

  it("handles an unanswered prompt, blank replies, and a closed preview", () => {
    const items = deriveTimelineMinimapItems(
      rows([
        ["user", "First"],
        ["assistant", " \n\t"],
        ["user", "Next"],
      ]),
    );
    expect(items.map((item) => resolveTimelineMinimapPreview(item)?.assistantText)).toEqual([
      null,
      null,
    ]);
    expect(resolveTimelineMinimapPreview(null)).toBeNull();
  });

  it("runs prompt text through the summarizer", () => {
    const items = deriveTimelineMinimapItems(rows([["user", "raw"]]), (text) => `clean ${text}`);
    expect(items[0]?.userText).toBe("clean raw");
  });
});

describe("timeline minimap geometry", () => {
  it("places ticks and maps the pointer back to a tick", () => {
    expect(resolveTimelineMinimapHeightStyle(5)).toBe("min(32px, calc(100vh - 18rem))");
    expect(resolveTimelineMinimapTopPercent(2, 5)).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 350,
      }),
    ).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 999,
      }),
    ).toBe(100);
  });

  it("only claims the gutter beside the column, never the message text", () => {
    expect(resolveTimelineMinimapHasPersistentGutter(863, 768)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(864, 768)).toBe(true);
    expect(resolveTimelineMinimapHitStripWidth(768, 768)).toBe(0);
    expect(resolveTimelineMinimapHitStripWidth(820, 768)).toBe(14);
    expect(resolveTimelineMinimapHitStripWidth(1400, 768)).toBe(40);
    expect(resolveTimelineMinimapHitStripWidth(Number.NaN, 768)).toBe(0);
  });

  it("treats the first turn on screen as the current one", () => {
    const itemBounds = [
      { top: 0, height: 100 },
      { top: 500, height: 100 },
      { top: 1200, height: 100 },
    ];
    expect(
      resolveTimelineMinimapCurrentIndex({ scrollTop: 450, scrollBottom: 900, itemBounds }),
    ).toBe(1);
    // Between prompts: the last one above the viewport.
    expect(
      resolveTimelineMinimapCurrentIndex({ scrollTop: 700, scrollBottom: 1100, itemBounds }),
    ).toBe(1);
  });
});
