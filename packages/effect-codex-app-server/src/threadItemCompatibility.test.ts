import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as CodexSchema from "./schema.ts";
import { decodeNotificationPayload, decodeOptionalPayload } from "./_internal/shared.ts";

const sleepItem = {
  type: "sleep",
  id: "call_cq8ugLYEYZtLW4IUaprReitP",
  durationMs: 20000,
} as const;

const completedSubAgentItem = {
  type: "subAgentActivity",
  id: "activity-1",
  agentPath: "/root/worker",
  agentThreadId: "agent-thread-1",
  kind: "completed",
} as const;

const thread = {
  id: "b5ae5a45-70e3-415c-b0dd-563d99a67740",
  sessionId: "session-1",
  cliVersion: "test",
  createdAt: 0,
  updatedAt: 1,
  cwd: "C:/work",
  ephemeral: false,
  modelProvider: "openai",
  preview: "Thread item compatibility",
  source: "appServer",
  status: { type: "idle" },
  turns: [{ id: "turn-1", status: "completed", items: [sleepItem] }],
} as const;

describe("thread item compatibility", () => {
  it.effect.each([sleepItem, completedSubAgentItem])(
    "resumes and reads a thread containing $type",
    (item) =>
      Effect.gen(function* () {
        const historyThread = {
          ...thread,
          turns: [{ ...thread.turns[0], items: [sleepItem, item] }],
        };
        const resume = {
          thread: historyThread,
          approvalPolicy: "never",
          approvalsReviewer: "user",
          cwd: thread.cwd,
          model: "test",
          modelProvider: "openai",
          sandbox: { type: "dangerFullAccess" },
        };
        expect(
          yield* decodeOptionalPayload("thread/resume", CodexSchema.V2ThreadResumeResponse, resume),
        ).toEqual(resume);
        expect(
          yield* decodeOptionalPayload("thread/read", CodexSchema.V2ThreadReadResponse, {
            thread: historyThread,
          }),
        ).toEqual({ thread: historyThread });
      }),
  );

  it.effect.each([sleepItem, completedSubAgentItem])(
    "decodes live $type start and completion notifications",
    (item) =>
      Effect.gen(function* () {
        const payload = {
          threadId: thread.id,
          turnId: "turn-1",
          item,
          startedAtMs: 0,
          completedAtMs: 20000,
        };
        expect(
          yield* decodeNotificationPayload(
            "item/started",
            CodexSchema.V2ItemStartedNotification,
            payload,
          ),
        ).toEqual(payload);
        expect(
          yield* decodeNotificationPayload(
            "item/completed",
            CodexSchema.V2ItemCompletedNotification,
            payload,
          ),
        ).toEqual(payload);
      }),
  );

  it("accepts all supported sub-agent activity kinds and rejects malformed ones", () => {
    const decode = Schema.decodeUnknownSync(CodexSchema.V2ThreadResumeResponse__ThreadItem);
    for (const kind of ["started", "interacted", "interrupted", "completed"]) {
      const item = { ...completedSubAgentItem, kind };
      expect(decode(item)).toEqual(item);
    }
    for (const kind of [undefined, 1, "invalid"]) {
      expect(() => decode({ ...completedSubAgentItem, kind })).toThrow();
    }
  });

  it("keeps duration and item validation strict", () => {
    const decode = Schema.decodeUnknownSync(CodexSchema.V2ThreadResumeResponse__ThreadItem);
    expect(decode({ ...sleepItem, durationMs: 0 })).toEqual({ ...sleepItem, durationMs: 0 });
    for (const durationMs of [undefined, "20000", -1, 0.5]) {
      expect(() => decode({ ...sleepItem, durationMs })).toThrow();
    }
    expect(() => decode({ type: "sleep", durationMs: 20000 })).toThrow();
    expect(() => decode({ type: "agentMessage", id: "invalid-message" })).toThrow();
  });
});
