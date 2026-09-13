// @effect-diagnostics globalDate:off - Fixtures for a standalone watchdog process.
import { assert, it } from "@effect/vitest";

import { findAbandoned, formatAbandoned } from "./watchdog-abandoned.ts";
import type { ThreadObservation } from "./watchdog-observe.ts";

const NOW = new Date("2026-09-09T06:00:00.000Z");

function thread(overrides: Partial<ThreadObservation> = {}): ThreadObservation {
  return {
    threadId: "thread-1",
    title: "Refactor the sync logic",
    projectId: "project-1",
    projectTitle: "dealjourney",
    workspaceRoot: "C:/repo",
    isOrchestrator: false,
    runtimeMode: "full-access",
    interactionMode: "default",
    modelSelection: null,
    archivedAt: null,
    doneAt: null,
    latestUserMessageAt: null,
    threadUpdatedAt: "2026-08-11T06:00:00.000Z",
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    latestTurn: {
      turnId: "turn-1",
      state: "running",
      requestedAt: "2026-08-11T05:00:00.000Z",
      startedAt: "2026-08-11T05:00:00.000Z",
      completedAt: null,
    },
    newestTurnRequestedAt: "2026-08-11T05:00:00.000Z",
    sessionStatus: "stopped",
    sessionUpdatedAt: "2026-08-11T06:00:00.000Z",
    providerName: "claudeAgent",
    providerInstanceId: "claudeAgent",
    runtimeErrorMessage: null,
    runtimeErrorAt: null,
    runtimeErrorTurnId: null,
    latestActivityAt: "2026-08-11T06:00:00.000Z",
    ...overrides,
  };
}

it("lists a conversation whose turn simply stopped, which is what a crash looks like", () => {
  const [entry] = findAbandoned([thread()], NOW);
  assert.equal(entry?.threadId, "thread-1");
  assert.equal(entry?.quietDays, 29);
  assert.include(entry?.stoppedBecause ?? "", "the app was almost certainly killed");
});

it("says what a recorded failure actually was, without the adapter's boilerplate", () => {
  const [entry] = findAbandoned(
    [
      thread({
        latestTurn: {
          turnId: "turn-1",
          state: "error",
          requestedAt: "2026-08-11T05:00:00.000Z",
          startedAt: "2026-08-11T05:00:00.000Z",
          completedAt: "2026-08-11T06:00:00.000Z",
        },
        runtimeErrorAt: "2026-08-11T06:00:00.000Z",
        runtimeErrorMessage:
          "Provider adapter process error (claudeAgent) for thread 1ea6b77b-84eb-4223-ab5e-59aabf3679ef: Claude Code returned an error result: No conversation found",
      }),
    ],
    NOW,
  );
  assert.equal(
    entry?.stoppedBecause,
    "Claude Code returned an error result: No conversation found",
  );
});

it("names a usage-limit stall that is far too old for the watchdog to touch", () => {
  const [entry] = findAbandoned(
    [
      thread({
        runtimeErrorAt: "2026-08-11T06:00:00.000Z",
        runtimeErrorMessage: "You've hit your session limit \u00b7 resets 3:40am (Europe/Oslo)",
      }),
    ],
    NOW,
  );
  assert.include(entry?.stoppedBecause ?? "", "too long ago for the watchdog to resume");
});

it("ignores anything recent, finished, or already put away", () => {
  const quiet = findAbandoned(
    [
      thread({ threadId: "recent", latestActivityAt: "2026-09-09T05:00:00.000Z" }),
      thread({ threadId: "done", doneAt: "2026-08-12T06:00:00.000Z" }),
      thread({ threadId: "archived", archivedAt: "2026-08-12T06:00:00.000Z" }),
    ],
    NOW,
  );
  assert.deepStrictEqual(quiet, []);
});

it("puts the longest-forgotten first, because that is the one nothing else will tell him", () => {
  const entries = findAbandoned(
    [
      thread({ threadId: "recent-ish", latestActivityAt: "2026-09-01T06:00:00.000Z" }),
      thread({ threadId: "ancient", latestActivityAt: "2026-06-25T06:00:00.000Z" }),
    ],
    NOW,
  );
  assert.deepStrictEqual(
    entries.map((entry) => entry.threadId),
    ["ancient", "recent-ish"],
  );
});

it("says so plainly when there is nothing to show", () => {
  assert.include(formatAbandoned([]), "Nothing has been left mid-work");
});

it("caps the printed list and counts the rest", () => {
  const many = Array.from({ length: 20 }, (_, index) =>
    thread({ threadId: `t-${index}`, latestActivityAt: "2026-07-01T06:00:00.000Z" }),
  );
  const printed = formatAbandoned(findAbandoned(many, NOW), 5);
  assert.include(printed, "and 15 more");
});
