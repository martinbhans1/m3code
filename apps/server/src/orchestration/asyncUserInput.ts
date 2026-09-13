import { UserInputQuestion, type ProviderUserInputAnswers } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const AsyncUserInputRequest = Schema.Struct({
  requestId: Schema.String,
  responseMode: Schema.Literal("message"),
  questions: Schema.Array(UserInputQuestion),
});

export function formatAsyncUserInputAnswer(
  request: typeof AsyncUserInputRequest.Type,
  answers: ProviderUserInputAnswers,
): string | undefined {
  if (request.questions.length === 0) return undefined;
  const sections: string[] = [];
  for (const question of request.questions) {
    const raw = answers[question.id];
    const answer =
      typeof raw === "string"
        ? raw
        : Array.isArray(raw) && raw.every((value) => typeof value === "string")
          ? raw.join("\n")
          : undefined;
    if (!answer?.trim()) return undefined;
    sections.push(`${question.question}\n${answer.trim()}`);
  }
  return `Answers to your questions:\n\n${sections.join("\n\n")}`;
}
