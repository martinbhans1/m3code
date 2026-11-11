import { EventId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProjectionThreadActivity } from "../persistence/Services/ProjectionThreadActivities.ts";
import {
  deriveRunningSubagentCountFromActivities,
  SHELL_SUMMARY_ACTIVITY_KINDS,
} from "./threadShellSummary.ts";

let nextId = 0;
const activity = (
  kind: "task.started" | "task.completed",
  payload: Record<string, unknown>,
): ProjectionThreadActivity => {
  nextId += 1;
  return {
    activityId: EventId.make(`activity-${nextId}`),
    threadId: ThreadId.make("thread-1"),
    turnId: null,
    tone: "info",
    kind,
    summary: kind,
    payload,
    createdAt: `2026-11-11T10:00:${String(nextId).padStart(2, "0")}.000Z`,
  };
};

describe("deriveRunningSubagentCountFromActivities", () => {
  it("counts subagents started and not yet reported back", () => {
    expect(
      deriveRunningSubagentCountFromActivities([
        activity("task.started", { taskId: "a", taskType: "local_agent" }),
        activity("task.started", { taskId: "b", taskType: "local_agent" }),
        activity("task.started", { taskId: "w", taskType: "local_workflow" }),
        activity("task.completed", { taskId: "a", status: "completed" }),
      ]),
    ).toBe(2);
  });

  it("ignores background shell commands, which can run for the life of the session", () => {
    expect(
      deriveRunningSubagentCountFromActivities([
        activity("task.started", { taskId: "dev-server", taskType: "local_bash" }),
      ]),
    ).toBe(0);
  });

  it("treats a failed or stopped subagent as reported back", () => {
    expect(
      deriveRunningSubagentCountFromActivities([
        activity("task.started", { taskId: "a", taskType: "local_agent" }),
        activity("task.started", { taskId: "b", taskType: "local_agent" }),
        activity("task.completed", { taskId: "a", status: "failed" }),
        activity("task.completed", { taskId: "b", status: "stopped" }),
      ]),
    ).toBe(0);
  });

  it("is listed as a kind the summary recomputes on, or it would never update", () => {
    expect(SHELL_SUMMARY_ACTIVITY_KINDS).toContain("task.started");
    expect(SHELL_SUMMARY_ACTIVITY_KINDS).toContain("task.completed");
  });
});
