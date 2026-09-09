// @effect-diagnostics globalDate:off - Fixtures for a standalone watchdog process.
import { assert, it } from "@effect/vitest";

import { decide } from "./watchdog-decide.ts";
import type { Snapshot, ThreadObservation } from "./watchdog-observe.ts";
import type { LedgerEntry } from "./watchdog-store.ts";

const LIMIT_MESSAGE = "You've hit your session limit \u00b7 resets 3:40am (Europe/Oslo)";
/** 01:15 Oslo, the moment everything stopped. */
const STOPPED_AT = "2026-09-09T01:15:00.000Z";
/** 03:40 Oslo, the moment the limit lifted, is 01:40 UTC. */
const AFTER_RESET = new Date("2026-09-09T01:45:00.000Z");
const BEFORE_RESET = new Date("2026-09-09T01:20:00.000Z");

function thread(overrides: Partial<ThreadObservation> = {}): ThreadObservation {
  return {
    threadId: "thread-1",
    title: "Deploy pipeline",
    projectId: "project-1",
    projectTitle: "dealjourney",
    workspaceRoot: "C:/repo",
    isOrchestrator: false,
    runtimeMode: "full-access",
    interactionMode: "default",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
    archivedAt: null,
    doneAt: null,
    latestUserMessageAt: "2026-09-08T22:00:00.000Z",
    threadUpdatedAt: STOPPED_AT,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    latestTurn: {
      turnId: "turn-1",
      state: "error",
      requestedAt: "2026-09-09T00:50:00.000Z",
      startedAt: "2026-09-09T00:50:00.000Z",
      completedAt: STOPPED_AT,
    },
    newestTurnRequestedAt: "2026-09-09T00:50:00.000Z",
    sessionStatus: "stopped",
    sessionUpdatedAt: STOPPED_AT,
    providerName: "claudeAgent",
    providerInstanceId: "claudeAgent",
    runtimeErrorMessage: LIMIT_MESSAGE,
    runtimeErrorAt: STOPPED_AT,
    runtimeErrorTurnId: "turn-1",
    latestActivityAt: STOPPED_AT,
    ...overrides,
  };
}

function snapshot(threads: readonly ThreadObservation[], serverRunning = true): Snapshot {
  return {
    takenAt: AFTER_RESET.toISOString(),
    databaseFile: "state.sqlite",
    serverPid: 1234,
    serverOrigin: "http://127.0.0.1:3773",
    serverRunning,
    orchestratorProjectId: "orchestrator-project",
    threadsWithFailedLatestTurn: threads.length,
    threads,
    stoppedMidWork: threads,
  };
}

function sentEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    at: "2026-09-09T01:46:00.000Z",
    threadId: "thread-1",
    threadTitle: "Deploy pipeline",
    projectTitle: "dealjourney",
    providerInstanceId: "claudeAgent",
    resetWindow: "2026-09-09T01:40:00.000Z",
    attempt: 1,
    scanId: "scan-1",
    outcome: "sent",
    ...overrides,
  };
}

it("restarts a conversation whose last turn died on a usage limit that has since lifted", () => {
  const decision = decide(snapshot([thread()]), [], AFTER_RESET);
  assert.equal(decision.action.kind, "nudge");
  assert.equal(decision.verdicts[0]?.verdict, "restart");
  if (decision.action.kind !== "nudge") return;
  assert.equal(decision.action.threadId, "thread-1");
  assert.equal(decision.action.attempt, 1);
  assert.include(decision.action.message, "hit its limit");
  assert.include(decision.action.message, "already finished");
});

it("waits while the named reset time is still in the future", () => {
  const decision = decide(snapshot([thread()]), [], BEFORE_RESET);
  assert.equal(decision.action.kind, "none");
  assert.equal(decision.verdicts[0]?.reason, "waiting-for-the-reset-time");
  assert.equal(decision.waitingUntil, "2026-09-09T01:40:00.000Z");
});

it("leaves conversations that stopped for any other reason completely alone", () => {
  const others = [
    thread({ threadId: "a", runtimeErrorMessage: "API Error: 529 Overloaded." }),
    thread({ threadId: "b", runtimeErrorMessage: "Selected model is at capacity." }),
    thread({ threadId: "c", runtimeErrorMessage: null, runtimeErrorAt: null }),
    thread({ threadId: "d", doneAt: "2026-09-09T01:16:00.000Z" }),
    thread({ threadId: "e", sessionStatus: "running" }),
    thread({ threadId: "f", latestUserMessageAt: "2026-09-09T01:30:00.000Z" }),
    thread({ threadId: "g", newestTurnRequestedAt: "2026-09-09T01:30:00.000Z" }),
    thread({ threadId: "h", runtimeErrorTurnId: "turn-0" }),
    thread({ threadId: "i", pendingApprovalCount: 1 }),
    thread({ threadId: "j", pendingUserInputCount: 1 }),
  ];
  const decision = decide(snapshot(others), [], AFTER_RESET);
  assert.equal(decision.action.kind, "none");
  assert.deepStrictEqual(
    decision.verdicts.map((verdict) => verdict.verdict),
    others.map(() => "ignore"),
  );
});

it("wakes the supervising conversation before the conversations it supervises", () => {
  const decision = decide(
    snapshot([
      thread({ threadId: "worker", runtimeErrorAt: "2026-09-09T01:00:00.000Z" }),
      thread({ threadId: "orchestrator", isOrchestrator: true }),
    ]),
    [],
    AFTER_RESET,
  );
  assert.equal(decision.action.kind, "nudge");
  if (decision.action.kind !== "nudge") return;
  assert.equal(decision.action.threadId, "orchestrator");
  assert.include(decision.action.message, "You supervise other conversations");
});

it("wakes one conversation per scan and waits for it to show life before the next", () => {
  const stalled = [thread({ threadId: "one" }), thread({ threadId: "two" })];
  const first = decide(snapshot(stalled), [], AFTER_RESET);
  assert.equal(first.action.kind, "nudge");

  const held = decide(
    snapshot(stalled),
    [sentEntry({ threadId: "one" })],
    new Date("2026-09-09T01:50:00.000Z"),
  );
  assert.equal(held.action.kind, "none");
  if (held.action.kind !== "none") return;
  assert.include(held.action.reason, "show-life");
});

it("lets a separate account recover in parallel, because they share no limit", () => {
  const stalled = [
    // Still stalled and still silent: the Claude account is mid-recovery.
    thread({ threadId: "claude-one", providerInstanceId: "claudeAgent" }),
    thread({ threadId: "claude-two", providerInstanceId: "claudeAgent" }),
    thread({ threadId: "codex-one", providerInstanceId: "codex" }),
  ];
  const decision = decide(
    snapshot(stalled),
    [sentEntry({ threadId: "claude-one", providerInstanceId: "claudeAgent" })],
    new Date("2026-09-09T01:50:00.000Z"),
  );
  assert.equal(decision.action.kind, "nudge");
  if (decision.action.kind !== "nudge") return;
  assert.equal(decision.action.threadId, "codex-one");
});

it("still holds every conversation on the account that is waiting on its last nudge", () => {
  const stalled = [
    thread({ threadId: "claude-one", providerInstanceId: "claudeAgent" }),
    thread({ threadId: "claude-two", providerInstanceId: "claudeAgent" }),
    thread({ threadId: "claude-three", providerInstanceId: "claudeAgent" }),
  ];
  const decision = decide(
    snapshot(stalled),
    [sentEntry({ threadId: "claude-one", providerInstanceId: "claudeAgent" })],
    new Date("2026-09-09T01:50:00.000Z"),
  );
  assert.equal(decision.action.kind, "none");
  if (decision.action.kind !== "none") return;
  assert.include(decision.action.reason, "claude-one");
});

it("releases the next conversation once the woken one has moved", () => {
  const moved = [
    thread({ threadId: "one", latestActivityAt: "2026-09-09T01:47:00.000Z" }),
    thread({ threadId: "two" }),
  ];
  const decision = decide(
    snapshot(moved),
    [sentEntry({ threadId: "one" })],
    new Date("2026-09-09T01:50:00.000Z"),
  );
  assert.equal(decision.action.kind, "nudge");
  if (decision.action.kind !== "nudge") return;
  assert.equal(decision.action.threadId, "two");
});

it("stops after the per-window attempt cap, so a limit that has not really lifted costs two nudges", () => {
  const ledger = [
    sentEntry({ at: "2026-09-09T01:45:00.000Z" }),
    sentEntry({ at: "2026-09-09T02:20:00.000Z", attempt: 2 }),
  ];
  const decision = decide(
    snapshot([thread({ latestActivityAt: "2026-09-09T02:25:00.000Z" })]),
    ledger,
    new Date("2026-09-09T03:00:00.000Z"),
  );
  assert.equal(decision.action.kind, "none");
  assert.equal(decision.verdicts[0]?.reason, "attempt-cap-for-this-reset-window");
});

it("will not nudge the same conversation twice in quick succession", () => {
  const decision = decide(
    snapshot([thread({ latestActivityAt: "2026-09-09T01:47:00.000Z" })]),
    [sentEntry()],
    new Date("2026-09-09T01:55:00.000Z"),
  );
  assert.equal(decision.action.kind, "none");
  assert.equal(decision.verdicts[0]?.reason, "nudged-too-recently");
});

it("honours the rolling spend caps", () => {
  const many = Array.from({ length: 8 }, (_, index) =>
    sentEntry({ threadId: `spent-${index}`, at: "2026-09-09T00:00:00.000Z" }),
  );
  const decision = decide(snapshot([thread()]), many, AFTER_RESET);
  assert.equal(decision.action.kind, "none");
  if (decision.action.kind !== "none") return;
  assert.equal(decision.action.reason, "six-hour-nudge-cap-reached");
});

it("leaves a stall that is already hours stale to the human who will see it", () => {
  const nextMorning = new Date("2026-09-09T14:00:00.000Z");
  const decision = decide(snapshot([thread()]), [], nextMorning);
  assert.equal(decision.action.kind, "none");
  assert.equal(decision.verdicts[0]?.reason, "stalled-too-long-ago-to-resume-unattended");
});

it("does nothing at all when the app is not running", () => {
  const decision = decide(snapshot([thread()], false), [], AFTER_RESET);
  assert.equal(decision.action.kind, "none");
  if (decision.action.kind !== "none") return;
  assert.equal(decision.action.reason, "app-is-not-running");
});

it("refuses to act when an implausible number of conversations look stalled", () => {
  const crowd = Array.from({ length: 13 }, (_, index) => thread({ threadId: `t-${index}` }));
  const decision = decide(snapshot(crowd), [], AFTER_RESET);
  assert.equal(decision.action.kind, "none");
  if (decision.action.kind !== "none") return;
  assert.include(decision.action.reason, "too-many-conversations-stalled");
});
