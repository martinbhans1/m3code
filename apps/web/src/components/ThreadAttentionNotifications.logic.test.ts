import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationLatestTurn,
} from "@t3tools/contracts";

import {
  evaluateThreadAttentionNotifications,
  resolveThreadAttentionSignal,
  type ThreadAttentionCandidate,
  type ThreadAttentionPreferences,
} from "./ThreadAttentionNotifications.logic";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-1");
const threadKey = `${environmentId}:${threadId}`;
const now = Date.parse("2026-03-09T10:10:00.000Z");

const allEnabled: ThreadAttentionPreferences = {
  enabled: true,
  turnCompleted: true,
  inputNeeded: true,
  failure: true,
  suppressWhenFocused: false,
};

function makeLatestTurn(overrides?: Partial<OrchestrationLatestTurn>): OrchestrationLatestTurn {
  return {
    turnId: "turn-1" as OrchestrationLatestTurn["turnId"],
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: "2026-03-09T10:00:00.000Z",
    completedAt: "2026-03-09T10:05:00.000Z",
    ...overrides,
  };
}

function makeCandidate(overrides?: {
  readonly archivedAt?: string | null;
  readonly threadTitle?: string;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly latestTurn?: OrchestrationLatestTurn | null;
  readonly sessionStatus?: "running" | "ready" | "error";
}): ThreadAttentionCandidate {
  const sessionStatus = overrides?.sessionStatus ?? "ready";
  return {
    key: threadKey,
    environmentId,
    threadId,
    threadTitle: overrides?.threadTitle ?? "Fix the sidebar",
    projectTitle: "m3code",
    archivedAt: overrides?.archivedAt ?? null,
    thread: {
      hasActionableProposedPlan: false,
      hasPendingApprovals: overrides?.hasPendingApprovals ?? false,
      hasPendingUserInput: overrides?.hasPendingUserInput ?? false,
      interactionMode: "default",
      latestTurn: overrides?.latestTurn === undefined ? makeLatestTurn() : overrides.latestTurn,
      updatedAt: "2026-03-09T10:05:00.000Z",
      session: {
        provider: ProviderDriverKind.make("codex"),
        status: sessionStatus,
        createdAt: "2026-03-09T10:00:00.000Z",
        updatedAt: "2026-03-09T10:05:00.000Z",
        orchestrationStatus: sessionStatus === "error" ? "error" : "ready",
      },
    },
  };
}

function evaluate(input: {
  readonly candidates: readonly ThreadAttentionCandidate[];
  readonly previous: ReadonlyMap<string, string>;
  readonly preferences?: ThreadAttentionPreferences;
  readonly activeThreadKey?: string | null;
  readonly windowFocused?: boolean;
}) {
  return evaluateThreadAttentionNotifications({
    candidates: input.candidates,
    previous: input.previous,
    preferences: input.preferences ?? allEnabled,
    activeThreadKey: input.activeThreadKey ?? null,
    windowFocused: input.windowFocused ?? false,
    now,
  });
}

describe("resolveThreadAttentionSignal", () => {
  it("stays quiet for a thread that is still working", () => {
    expect(
      resolveThreadAttentionSignal(
        makeCandidate({
          sessionStatus: "running",
          latestTurn: makeLatestTurn({ state: "running", completedAt: null }),
        }),
        now,
      ),
    ).toBeNull();
  });

  it("stays quiet for an archived thread that just finished", () => {
    expect(
      resolveThreadAttentionSignal(makeCandidate({ archivedAt: "2026-03-09T10:06:00.000Z" }), now),
    ).toBeNull();
  });

  it("reports a failed session ahead of anything else", () => {
    expect(
      resolveThreadAttentionSignal(makeCandidate({ sessionStatus: "error" }), now),
    ).toMatchObject({ kind: "failed", headline: "Agent failed" });
  });

  it("separates approvals from plain completion", () => {
    expect(
      resolveThreadAttentionSignal(makeCandidate({ hasPendingApprovals: true }), now),
    ).toMatchObject({ kind: "input-needed", headline: "Approval needed" });
    expect(resolveThreadAttentionSignal(makeCandidate(), now)).toMatchObject({
      kind: "completed",
      headline: "Agent finished",
    });
  });
});

describe("evaluateThreadAttentionNotifications", () => {
  it("records a thread on first sight without announcing it", () => {
    const evaluation = evaluate({ candidates: [makeCandidate()], previous: new Map() });

    expect(evaluation.notifications).toEqual([]);
    expect(evaluation.state.get(threadKey)).toContain("completed:");
  });

  it("announces a turn that finishes after the thread was seen working", () => {
    const working = evaluate({
      candidates: [
        makeCandidate({
          sessionStatus: "running",
          latestTurn: makeLatestTurn({ state: "running", completedAt: null }),
        }),
      ],
      previous: new Map(),
    });

    const finished = evaluate({ candidates: [makeCandidate()], previous: working.state });

    expect(finished.notifications).toHaveLength(1);
    expect(finished.notifications[0]).toMatchObject({
      threadId,
      kind: "completed",
      title: "Fix the sidebar",
      body: "Agent finished · m3code",
    });
  });

  it("does not repeat itself while the thread sits in the same state", () => {
    const first = evaluate({
      candidates: [makeCandidate({ hasPendingApprovals: true })],
      previous: new Map(),
    });
    const second = evaluate({
      candidates: [makeCandidate({ hasPendingApprovals: true })],
      previous: first.state,
    });
    const third = evaluate({
      candidates: [makeCandidate({ hasPendingApprovals: true })],
      previous: second.state,
    });

    expect(second.notifications).toEqual([]);
    expect(third.notifications).toEqual([]);
  });

  it("announces the next approval once the thread has moved on and back", () => {
    const approved = evaluate({
      candidates: [makeCandidate({ hasPendingApprovals: true })],
      previous: new Map([[threadKey, "running"]]),
    });
    const working = evaluate({
      candidates: [
        makeCandidate({
          sessionStatus: "running",
          latestTurn: makeLatestTurn({ state: "running", completedAt: null }),
        }),
      ],
      previous: approved.state,
    });
    const approvedAgain = evaluate({
      candidates: [makeCandidate({ hasPendingApprovals: true })],
      previous: working.state,
    });

    expect(approved.notifications).toHaveLength(1);
    expect(working.notifications).toEqual([]);
    expect(approvedAgain.notifications).toHaveLength(1);
  });

  it("keeps quiet about the thread the user is already looking at", () => {
    const evaluation = evaluate({
      candidates: [makeCandidate()],
      previous: new Map([[threadKey, "running"]]),
      activeThreadKey: threadKey,
      windowFocused: true,
    });

    expect(evaluation.notifications).toEqual([]);
    // Recorded as seen, so leaving the thread does not release a stale toast.
    expect(evaluation.state.get(threadKey)).toContain("completed:");
  });

  it("still announces another thread while the app has focus", () => {
    const evaluation = evaluate({
      candidates: [makeCandidate()],
      previous: new Map([[threadKey, "running"]]),
      activeThreadKey: "environment-local:thread-other",
      windowFocused: true,
    });

    expect(evaluation.notifications).toHaveLength(1);
  });

  it("honours the preference to stay silent whenever the app has focus", () => {
    const evaluation = evaluate({
      candidates: [makeCandidate()],
      previous: new Map([[threadKey, "running"]]),
      preferences: { ...allEnabled, suppressWhenFocused: true },
      activeThreadKey: "environment-local:thread-other",
      windowFocused: true,
    });

    expect(evaluation.notifications).toEqual([]);
  });

  it("drops a disabled category without holding it for later", () => {
    const evaluation = evaluate({
      candidates: [makeCandidate()],
      previous: new Map([[threadKey, "running"]]),
      preferences: { ...allEnabled, turnCompleted: false },
    });

    expect(evaluation.notifications).toEqual([]);
    expect(evaluation.state.get(threadKey)).toContain("completed:");

    const afterEnabling = evaluate({
      candidates: [makeCandidate()],
      previous: evaluation.state,
    });
    expect(afterEnabling.notifications).toEqual([]);
  });

  it("says nothing at all while notifications are switched off", () => {
    const evaluation = evaluate({
      candidates: [makeCandidate()],
      previous: new Map([[threadKey, "running"]]),
      preferences: { ...allEnabled, enabled: false },
    });

    expect(evaluation.notifications).toEqual([]);
  });

  it("forgets threads that are no longer loaded", () => {
    const evaluation = evaluate({
      candidates: [],
      previous: new Map([[threadKey, "completed:2026-03-09T10:05:00.000Z"]]),
    });

    expect(evaluation.state.size).toBe(0);
  });
});
