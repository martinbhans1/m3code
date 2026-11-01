import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildFollowupPrompt, derivePendingFollowups } from "./followups.ts";

function activity(
  sequence: number,
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: `activity-${sequence}`,
    kind,
    tone: "info",
    summary: "",
    payload,
    turnId: null,
    sequence,
    createdAt: `2026-11-01T00:00:0${sequence}.000Z`,
  } as unknown as OrchestrationThreadActivity;
}

const suggested = (sequence: number, id: string, status: string, detail: string | null = null) =>
  activity(sequence, "turn.followup.suggested", {
    followup: { id, title: `Task ${id}`, detail, status },
  });

describe("derivePendingFollowups", () => {
  it("lets the latest record per follow-up decide whether it is still on the deck", () => {
    const pending = derivePendingFollowups([
      suggested(1, "a", "pending"),
      suggested(2, "b", "pending"),
      suggested(3, "a", "dismissed"),
    ]);
    expect(pending.map((followup) => followup.id)).toEqual(["b"]);
  });

  it("recovers a description the agent filed under the wrong name", () => {
    const [followup] = derivePendingFollowups([
      suggested(1, "a", "pending"),
      activity(2, "tool.completed", {
        data: {
          toolName: "mcp__t3-code__suggest_followup",
          result: { tool_use_id: "a" },
          input: { title: "Task a", description: "The real body" },
        },
      }),
    ]);
    expect(followup?.detail).toBe("The real body");
  });
});

describe("buildFollowupPrompt", () => {
  it("puts the user's own context last so it outranks the suggestion", () => {
    const prompt = buildFollowupPrompt(
      { title: "Fix it", detail: "Details", rationale: "Because" },
      "Only on mobile",
    );
    expect(prompt.startsWith("Fix it\n\nDetails\n\nWhy: Because")).toBe(true);
    expect(prompt.endsWith("Only on mobile")).toBe(true);
  });
});
