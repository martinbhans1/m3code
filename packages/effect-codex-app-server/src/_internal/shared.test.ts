import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import * as CodexSchema from "../schema.ts";
import { decodeNotificationPayload } from "./shared.ts";

describe("notification compatibility", () => {
  it.effect("preserves structured async questions from a newer app-server", () =>
    Effect.gen(function* () {
      const payload = {
        threadId: "thread-1",
        turnId: "turn-1",
        startedAtMs: 0,
        completedAtMs: 1,
        item: {
          type: "agentMessage",
          id: "question-1",
          text: "Choose a style\n- Short\n- Detailed",
          phase: "final_answer",
          delivery: "async",
          questions: [{ title: "Choose a style", options: ["Short", "Detailed"] }],
        },
      };
      for (const schema of [
        CodexSchema.V2ItemStartedNotification,
        CodexSchema.V2ItemCompletedNotification,
      ]) {
        expect(
          yield* decodeNotificationPayload<unknown, unknown>("item/completed", schema, payload),
        ).toEqual(payload);
      }
    }),
  );
});
