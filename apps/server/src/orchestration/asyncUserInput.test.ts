import { describe, expect, it } from "vite-plus/test";
import { formatAsyncUserInputAnswer } from "./asyncUserInput.ts";

describe("async answers", () => {
  const request = {
    requestId: "request-1",
    responseMode: "message" as const,
    questions: [
      { id: "q1", header: "Question", question: "Which fruit?", options: [], multiSelect: false },
    ],
  };
  it("includes the question context with free-text answers", () => {
    expect(formatAsyncUserInputAnswer(request, { q1: "Banana" })).toBe(
      "Answers to your questions:\n\nWhich fruit?\nBanana",
    );
  });
  it("does not submit missing, empty, or malformed answers", () => {
    for (const answers of [{}, { q1: " " }, { q1: [] }, { q1: { answer: "Banana" } }]) {
      expect(formatAsyncUserInputAnswer(request, answers)).toBeUndefined();
    }
  });
});
