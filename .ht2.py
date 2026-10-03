import io

p = "apps/server/src/mcp/toolkits/orchestrator/handlers.test.ts"
s = io.open(p, encoding="utf-8").read()


def sub(old, new):
    global s
    assert s.count(old) == 1, "bad anchor: " + old[:70]
    s = s.replace(old, new, 1)


# ------------------------------------------------ approval fixture
sub(
    """const questionThreadDetail = {""",
    """const blockedThreadDetail = {
  ...blockedThread,
  messages: [],
  proposedPlans: [],
  activities: [
    {
      // Already answered, so it must not be offered again.
      id: "activity-a0",
      tone: "approval",
      kind: "approval.requested",
      summary: "Command approval requested",
      payload: {
        requestId: "approval-answered",
        requestKind: "command",
        detail: "rm -rf node_modules",
      },
      turnId: "turn-3",
      createdAt: "2026-08-05T09:09:00.000Z",
    },
    {
      id: "activity-a1",
      tone: "approval",
      kind: "approval.resolved",
      summary: "Approval resolved",
      payload: { requestId: "approval-answered", decision: "accept" },
      turnId: "turn-3",
      createdAt: "2026-08-05T09:10:00.000Z",
    },
    {
      id: "activity-a2",
      tone: "approval",
      kind: "approval.requested",
      summary: "Command approval requested",
      payload: {
        requestId: "approval-open",
        requestKind: "command",
        detail: "pnpm test --filter @t3tools/web",
      },
      turnId: "turn-3",
      createdAt: "2026-08-05T09:12:00.000Z",
    },
  ],
};

const questionThreadDetail = {""",
)

sub(
    """        const detail =
          threadId === idleThreadId
            ? threadDetail
            : threadId === questionThreadId
              ? questionThreadDetail
              : null;""",
    """        const detail =
          threadId === idleThreadId
            ? threadDetail
            : threadId === questionThreadId
              ? questionThreadDetail
              : threadId === blockedThreadId
                ? blockedThreadDetail
                : null;""",
)

# ------------------------------------------------------- new tests
s = s.rstrip() + '''

it.effect("puts the pending approval detail where the user can see it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      const read = yield* callTool("read_thread", { threadId: blockedThreadId });
      expect(read.isError).toBe(false);
      const pending = (
        read.structuredContent as {
          pendingApprovals: ReadonlyArray<Record<string, unknown>>;
        }
      ).pendingApprovals;
      // Only the outstanding one: an approval already answered is not a choice.
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        requestId: "approval-open",
        requestKind: "command",
        detail: "pnpm test --filter @t3tools/web",
      });

      // The same detail reaches the "what am I forgetting?" surface, so the
      // user can decide without opening each thread.
      const listed = yield* callTool("list_pending", { sections: ["approvals"] });
      expect(
        (
          listed.structuredContent as {
            pendingApprovalRequests: ReadonlyArray<Record<string, unknown>>;
          }
        ).pendingApprovalRequests,
      ).toMatchObject([{ requestId: "approval-open", detail: "pnpm test --filter @t3tools/web" }]);
      resetAccess();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("relays an approval decision to the thread that asked", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;

      const responded = yield* callTool("respond_to_approval", {
        threadId: blockedThreadId,
        decision: "accept",
      });
      expect(responded.isError).toBe(false);
      // Echoed back so the orchestrator reports what it actually allowed
      // rather than what it meant to.
      expect(responded.structuredContent).toMatchObject({
        requestId: "approval-open",
        decision: "accept",
        detail: "pnpm test --filter @t3tools/web",
      });
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "thread.approval.respond",
        threadId: blockedThreadId,
        requestId: "approval-open",
        decision: "accept",
      });

      dispatched.length = 0;
      resetAccess();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses an approval it cannot pin to a request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;

      // A requestId that is not outstanding must never fall back to "the other
      // one" — that would run a command the user never saw.
      const wrong = yield* callTool("respond_to_approval", {
        threadId: blockedThreadId,
        decision: "accept",
        requestId: "approval-answered",
      });
      expect(wrong.isError).toBe(true);
      expect(dispatched).toHaveLength(0);

      // And a thread with nothing outstanding is an error rather than a no-op.
      const none = yield* callTool("respond_to_approval", {
        threadId: idleThreadId,
        decision: "accept",
      });
      expect(none.isError).toBe(true);
      expect(dispatched).toHaveLength(0);

      resetAccess();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("will not answer an approval on a conversation it may only watch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;
      threadAccess = { [blockedThreadId]: "watch" };

      const responded = yield* callTool("respond_to_approval", {
        threadId: blockedThreadId,
        decision: "accept",
      });
      expect(responded.isError).toBe(true);
      expect(dispatched).toHaveLength(0);

      resetAccess();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("stops a running turn, and refuses when there is nothing running", () =>
  Effect.scoped(
    Effect.gen(function* () {
      resetAccess();
      dispatched.length = 0;

      const stopped = yield* callTool("stop_thread", { threadId: busyThreadId });
      expect(stopped.isError).toBe(false);
      expect(stopped.structuredContent).toMatchObject({
        threadId: busyThreadId,
        hadRunningTurn: true,
      });
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "thread.turn.interrupt",
        threadId: busyThreadId,
      });

      // Reporting "stopped it" for a thread that had already finished is the
      // kind of thing the user acts on, so it is refused rather than faked.
      dispatched.length = 0;
      const idle = yield* callTool("stop_thread", { threadId: idleThreadId });
      expect(idle.isError).toBe(true);
      expect(dispatched).toHaveLength(0);

      resetAccess();
    }),
  ).pipe(Effect.provide(TestLayer)),
);
'''

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("ok")
