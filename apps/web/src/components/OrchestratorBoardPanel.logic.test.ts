import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../types";
import { classifyThread, primaryActionFor, timingFor } from "./OrchestratorBoardPanel.logic";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function thread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: EnvironmentId.make("environment-local"),
    projectId: ProjectId.make("project-dealjourney"),
    title: "Refactor WebCRM sync logic",
    interactionMode: "build",
    session: null,
    createdAt: new Date(Date.now() - 4 * HOUR_MS).toISOString(),
    archivedAt: null,
    pinnedAt: null,
    doneAt: null,
    updatedAt: new Date().toISOString(),
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasPendingFollowups: false,
    hasActionableProposedPlan: false,
    handoffThreadId: null,
    ...overrides,
  } as SidebarThreadSummary;
}

function session(agoMs: number): SidebarThreadSummary["session"] {
  return {
    provider: ProviderDriverKind.make("claudeAgent"),
    status: "running",
    createdAt: new Date(Date.now() - agoMs).toISOString(),
    updatedAt: new Date(Date.now() - agoMs).toISOString(),
    orchestrationStatus: "running",
  } as SidebarThreadSummary["session"];
}

describe("classifyThread", () => {
  it("keeps a conversation that is genuinely running under Working", () => {
    expect(classifyThread(thread({ session: session(2 * MINUTE_MS) }))).toEqual({
      group: "working",
      detail: null,
    });
  });

  it("files a turn that stopped reporting under Stalled instead", () => {
    // The case the board got wrong: a turn only leaves "running" because an
    // event says so, and that event is lost when the app is killed. Five of
    // these read as "5 working" when none of them were.
    expect(classifyThread(thread({ session: session(72 * HOUR_MS) }))).toEqual({
      group: "stalled",
      detail: null,
    });
  });

  it("leaves the detail empty whenever the status dot already says it", () => {
    // The subtitle is one line. Spending it on "Awaiting Input" next to a dot
    // labelled "Awaiting Input" is spending it on nothing.
    for (const blocked of [
      thread({ hasPendingUserInput: true }),
      thread({ hasPendingApprovals: true }),
      thread({ session: session(MINUTE_MS) }),
    ]) {
      expect(classifyThread(blocked).detail).toBeNull();
    }
  });

  it("still names the states no dot has a colour for", () => {
    expect(
      classifyThread(
        thread({ latestTurn: { state: "interrupted" } as SidebarThreadSummary["latestTurn"] }),
      ),
    ).toEqual({ group: "needsYou", detail: "Interrupted, never resumed" });
    expect(classifyThread(thread({ hasPendingFollowups: true }))).toEqual({
      group: "settled",
      detail: "Open follow-ups",
    });
  });
});

describe("timingFor", () => {
  it("says how long you have been waiting, not merely that you are", () => {
    const waiting = thread({
      hasPendingUserInput: true,
      updatedAt: new Date(Date.now() - 12 * MINUTE_MS).toISOString(),
    });
    expect(timingFor(waiting, "needsYou")).toBe("waiting 12m");
  });

  it("phrases the time for what the group means", () => {
    const stalled = thread({ session: session(72 * HOUR_MS) });
    expect(timingFor(stalled, "stalled")).toBe("silent for 3d");

    const working = thread({
      latestTurn: {
        startedAt: new Date(Date.now() - 3 * MINUTE_MS).toISOString(),
      } as SidebarThreadSummary["latestTurn"],
    });
    expect(timingFor(working, "working")).toBe("running 3m");

    const settled = thread({
      latestTurn: {
        completedAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      } as SidebarThreadSummary["latestTurn"],
    });
    expect(timingFor(settled, "settled")).toBe("2h ago");
  });
});

describe("primaryActionFor", () => {
  const row = (
    overrides: Partial<SidebarThreadSummary>,
    group: "stalled" | "working" | "settled" | "needsYou",
  ) =>
    ({
      thread: thread(overrides),
      projectTitle: "dealjourney",
      access: "control" as const,
      group,
      detail: null,
      timing: null,
    }) as Parameters<typeof primaryActionFor>[0];

  it("offers what you would have asked for, per state", () => {
    expect(primaryActionFor(row({ hasPendingApprovals: true }, "needsYou"))?.label).toBe(
      "Ask what it wants to run",
    );
    expect(primaryActionFor(row({ hasPendingUserInput: true }, "needsYou"))?.label).toBe(
      "Show me the question",
    );
    expect(primaryActionFor(row({}, "stalled"))?.label).toBe("Clear the dead turn");
    expect(primaryActionFor(row({}, "working"))?.label).toBe("Catch me up");
    expect(primaryActionFor(row({}, "settled"))?.label).toBe("What did it change?");
  });

  it("names the conversation, so the orchestrator does not have to guess which", () => {
    expect(primaryActionFor(row({ hasPendingUserInput: true }, "needsYou"))?.prompt).toContain(
      '"Refactor WebCRM sync logic"',
    );
  });

  it("asks the orchestrator to check the disk rather than take an agent's word", () => {
    // The difference between a switchboard relaying claims and something that
    // can tell you whether the work is actually there.
    expect(primaryActionFor(row({}, "settled"))?.prompt).toContain("rather than what it said");
  });
});
