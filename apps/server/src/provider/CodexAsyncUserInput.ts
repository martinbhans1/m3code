import { ApprovalRequestId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// Codex 0.154 emits async questions as agentMessage items, not server requests.
// Decode separately from the generated protocol to remain compatible with older CLIs.
export const CodexAsyncUserInputNotification = Schema.Struct({
  item: Schema.Struct({
    type: Schema.Literal("agentMessage"),
    id: Schema.String,
    delivery: Schema.Literal("async"),
    questions: Schema.Array(
      Schema.Struct({
        title: Schema.String,
        options: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
      }),
    ),
  }),
});

export function codexAsyncUserInputPayload(item: typeof CodexAsyncUserInputNotification.Type.item) {
  if (
    !item.id ||
    item.questions.length === 0 ||
    item.questions.some((q) => !q.title.trim() || q.options?.some((option) => !option.trim()))
  ) {
    return undefined;
  }
  return {
    requestId: ApprovalRequestId.make(`codex-async:${item.id}`),
    payload: {
      responseMode: "message" as const,
      questions: item.questions.map((question, index) => ({
        id: `question_${index + 1}`,
        header: "Question",
        question: question.title.trim(),
        options: (question.options ?? []).map((label) => ({
          label: label.trim(),
          description: "",
        })),
        ...(question.options?.[0] ? { defaultOptionLabel: question.options[0].trim() } : {}),
        multiSelect: false,
      })),
    },
  };
}
