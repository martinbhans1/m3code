import { describe, expect, it } from "vite-plus/test";

import {
  renderSeedHistory,
  renderSeedHistoryForThread,
  SEED_HISTORY_CONDENSED_PREVIEW_CHARS,
  SEED_HISTORY_FULL_TEXT_BUDGET,
  SEED_HISTORY_MAX_CONDENSED_MESSAGES,
  SEED_HISTORY_MAX_FULL_MESSAGES,
  SEED_HISTORY_TAG,
  seedHistoryNoticeMessage,
  selectSeedHistoryMessages,
  type SeedHistoryMessage,
} from "./sessionSeedHistory.ts";

function message(
  role: "user" | "assistant",
  text: string,
  minute = 0,
  streaming = false,
): SeedHistoryMessage {
  const stamp = `2026-09-03T18:${String(minute).padStart(2, "0")}:00.000Z`;
  return { role, text, createdAt: stamp, streaming };
}

function exchange(count: number, bodyLength = 50): Array<SeedHistoryMessage> {
  const messages: Array<SeedHistoryMessage> = [];
  for (let index = 0; index < count; index += 1) {
    const role = index % 2 === 0 ? "user" : "assistant";
    messages.push(message(role, `${role} ${index} ${"x".repeat(bodyLength)}`, index % 60));
  }
  return messages;
}

describe("selectSeedHistoryMessages", () => {
  it("drops the unanswered tail so the live prompt is not shown twice", () => {
    const selected = selectSeedHistoryMessages([
      message("user", "first"),
      message("assistant", "reply"),
      message("user", "the message being sent right now"),
    ]);

    expect(selected.map((entry) => entry.text)).toEqual(["first", "reply"]);
  });

  it("drops every trailing user message, not just the last one", () => {
    const selected = selectSeedHistoryMessages([
      message("user", "first"),
      message("assistant", "reply"),
      message("user", "queued one"),
      message("user", "queued two"),
    ]);

    expect(selected.map((entry) => entry.text)).toEqual(["first", "reply"]);
  });

  it("ignores streaming and empty messages", () => {
    const selected = selectSeedHistoryMessages([
      message("user", "first"),
      message("assistant", "   "),
      message("assistant", "half written", 1, true),
      message("assistant", "reply"),
    ]);

    expect(selected.map((entry) => entry.text)).toEqual(["first", "reply"]);
  });

  it("returns nothing when the agent has never answered", () => {
    expect(selectSeedHistoryMessages([message("user", "only message")])).toEqual([]);
  });
});

describe("renderSeedHistory", () => {
  it("returns undefined for a thread with nothing to rebuild", () => {
    expect(renderSeedHistory([])).toBeUndefined();
    expect(
      renderSeedHistory([message("user", "first turn of a brand new thread")]),
    ).toBeUndefined();
  });

  it("reproduces a short conversation in full inside a tagged block", () => {
    const result = renderSeedHistory([
      message("user", "what should our marketing angle be"),
      message("assistant", "lead with the public changelog"),
      message("user", "picking this back up"),
    ]);

    expect(result).toBeDefined();
    const text = result?.text ?? "";
    expect(text.startsWith(`<${SEED_HISTORY_TAG}>`)).toBe(true);
    expect(text.trimEnd().endsWith(`</${SEED_HISTORY_TAG}>`)).toBe(true);
    expect(text).toContain("what should our marketing angle be");
    expect(text).toContain("lead with the public changelog");
    // The unanswered prompt is delivered live, so it must not also appear here.
    expect(text).not.toContain("picking this back up");
    expect(result?.stats).toEqual({ fullCount: 2, condensedCount: 0, droppedCount: 0 });
  });

  it("says plainly that the history is all the memory there is", () => {
    const text =
      renderSeedHistory([message("user", "hello"), message("assistant", "hi")])?.text ?? "";

    expect(text).toContain("could no longer be resumed");
    expect(text).toContain("rely on nothing beyond it");
  });

  it("keeps recent messages in full and condenses the rest", () => {
    const result = renderSeedHistory(exchange(40));

    expect(result?.stats.fullCount).toBe(SEED_HISTORY_MAX_FULL_MESSAGES);
    expect(result?.stats.condensedCount).toBe(40 - SEED_HISTORY_MAX_FULL_MESSAGES);
    expect(result?.stats.droppedCount).toBe(0);
    expect(result?.text).toContain("opening lines only");
    // Newest message is in the full section, oldest only as a condensed line.
    expect(result?.text).toContain("### assistant");
  });

  it("names how many messages it had to leave out entirely", () => {
    const total = SEED_HISTORY_MAX_FULL_MESSAGES + SEED_HISTORY_MAX_CONDENSED_MESSAGES + 10;
    const result = renderSeedHistory(exchange(total));

    expect(result?.stats.condensedCount).toBe(SEED_HISTORY_MAX_CONDENSED_MESSAGES);
    expect(result?.stats.droppedCount).toBe(10);
    expect(result?.text).toContain("10 older messages omitted");
  });

  it("stays bounded when every message is enormous", () => {
    const giant = Array.from({ length: 30 }, (_unused, index) =>
      message(index % 2 === 0 ? "user" : "assistant", "y".repeat(50_000), index),
    );

    const result = renderSeedHistory(giant);

    expect(result).toBeDefined();
    // Full window budget, plus the condensed lines and the fixed preamble.
    const generousCeiling =
      SEED_HISTORY_FULL_TEXT_BUDGET +
      SEED_HISTORY_MAX_CONDENSED_MESSAGES * (SEED_HISTORY_CONDENSED_PREVIEW_CHARS + 60) +
      4_000;
    expect((result?.text ?? "").length).toBeLessThan(generousCeiling);
    expect(result?.text).toContain("message truncated to fit");
  });

  it("condenses a long message to a single line", () => {
    const result = renderSeedHistory([
      message("user", `start ${"a".repeat(5_000)} end`),
      ...exchange(SEED_HISTORY_MAX_FULL_MESSAGES + 1),
    ]);

    const condensedLines = (result?.text ?? "")
      .split("\n")
      .filter((line) => line.startsWith("- [user 2026-"));
    expect(condensedLines.length).toBeGreaterThan(0);
    for (const line of condensedLines) {
      expect(line.length).toBeLessThan(SEED_HISTORY_CONDENSED_PREVIEW_CHARS + 80);
    }
  });

  it("names the reason when one is given", () => {
    const text =
      renderSeedHistory([message("user", "hello"), message("assistant", "hi")], {
        reason: "the saved transcript was deleted",
      })?.text ?? "";

    expect(text).toContain("the saved transcript was deleted");
  });
});

describe("seedHistoryNoticeMessage", () => {
  it("fits the work log's row label and names the cause", () => {
    for (const reason of ["expired", "rejected", "absent"] as const) {
      const notice = seedHistoryNoticeMessage(reason);
      expect(notice.length).toBeLessThanOrEqual(120);
      expect(notice).toContain("Memory rebuilt from the visible history");
    }

    expect(seedHistoryNoticeMessage("expired")).toContain("expired");
  });
});

describe("renderSeedHistoryForThread", () => {
  const base = { streaming: false, replyToMessageId: null };

  it("keeps the main conversation and leaves side threads and notices out", () => {
    const result = renderSeedHistoryForThread([
      { ...base, role: "user", text: "main question", createdAt: "2026-09-03T18:00:00.000Z" },
      {
        ...base,
        role: "user",
        text: "aside on an earlier message",
        createdAt: "2026-09-03T18:01:00.000Z",
        replyToMessageId: "message-1",
      },
      { ...base, role: "system", text: "app notice", createdAt: "2026-09-03T18:02:00.000Z" },
      { ...base, role: "assistant", text: "main answer", createdAt: "2026-09-03T18:03:00.000Z" },
    ]);

    const text = result?.text ?? "";
    expect(text).toContain("main question");
    expect(text).toContain("main answer");
    expect(text).not.toContain("aside on an earlier message");
    expect(text).not.toContain("app notice");
    expect(result?.stats.fullCount).toBe(2);
  });

  it("returns undefined for a thread the agent has never answered in", () => {
    expect(
      renderSeedHistoryForThread([
        {
          ...base,
          role: "user",
          text: "first ever message",
          createdAt: "2026-09-03T18:00:00.000Z",
        },
      ]),
    ).toBeUndefined();
  });
});
