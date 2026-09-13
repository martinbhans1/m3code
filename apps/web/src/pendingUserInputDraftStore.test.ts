import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  selectPendingUserInputDraft,
  usePendingUserInputDraftStore,
} from "./pendingUserInputDraftStore";
import {
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput";
import type { UserInputQuestion } from "@t3tools/contracts";

const QUESTIONS: UserInputQuestion[] = [
  {
    id: "q1",
    header: "SCOPE",
    question: "Which one?",
    multiSelect: false,
    options: [
      { label: "First", description: "First option" },
      { label: "Second", description: "Second option" },
    ],
  },
  {
    id: "q2",
    header: "STATUSES",
    question: "Which ones?",
    multiSelect: true,
    options: [
      { label: "Labels", description: "Tenant-set labels" },
      { label: "Translate", description: "Translate the portal" },
    ],
  },
];

describe("pendingUserInputDraftStore", () => {
  beforeEach(() => usePendingUserInputDraftStore.setState({ byRequestId: {} }));

  it("returns one stable empty reference for a request with no draft", () => {
    // zustand v5 compares selector results with Object.is, so a fresh object for
    // the empty case would re-render forever (React error #185).
    const { byRequestId } = usePendingUserInputDraftStore.getState();
    expect(selectPendingUserInputDraft(byRequestId, "req-1")).toBe(
      selectPendingUserInputDraft(byRequestId, "req-1"),
    );
    expect(selectPendingUserInputDraft(byRequestId, null)).toBe(
      selectPendingUserInputDraft(byRequestId, "req-1"),
    );
  });

  it("keeps selections, typed answers and the question you were on", () => {
    const { updateAnswer, setQuestionIndex } = usePendingUserInputDraftStore.getState();

    updateAnswer("req-1", "q1", (existing) =>
      togglePendingUserInputOptionSelection(QUESTIONS[0]!, existing, "Second"),
    );
    setQuestionIndex("req-1", 1);
    updateAnswer("req-1", "q2", (existing) =>
      setPendingUserInputCustomAnswer(existing, "A whole novella of an answer."),
    );

    // Reading it back is what a re-mounted ChatView does after a trip to
    // another conversation.
    const draft = selectPendingUserInputDraft(
      usePendingUserInputDraftStore.getState().byRequestId,
      "req-1",
    );
    const progress = derivePendingUserInputProgress(QUESTIONS, draft.answers, draft.questionIndex!);

    expect(draft.questionIndex).toBe(1);
    expect(progress.activeQuestion?.id).toBe("q2");
    expect(progress.customAnswer).toBe("A whole novella of an answer.");
    expect(progress.isComplete).toBe(true);
  });

  it("opens on the first unanswered question when no place was recorded", () => {
    const { updateAnswer } = usePendingUserInputDraftStore.getState();
    updateAnswer("req-1", "q1", (existing) =>
      togglePendingUserInputOptionSelection(QUESTIONS[0]!, existing, "First"),
    );

    const draft = selectPendingUserInputDraft(
      usePendingUserInputDraftStore.getState().byRequestId,
      "req-1",
    );

    expect(draft.questionIndex).toBeNull();
    expect(findFirstUnansweredPendingUserInputQuestionIndex(QUESTIONS, draft.answers)).toBe(1);
  });

  it("drops the draft once its answers have been submitted", () => {
    const { updateAnswer, clear } = usePendingUserInputDraftStore.getState();
    updateAnswer("req-1", "q1", (existing) =>
      togglePendingUserInputOptionSelection(QUESTIONS[0]!, existing, "First"),
    );
    clear("req-1");

    expect(usePendingUserInputDraftStore.getState().byRequestId).toEqual({});
  });

  it("keeps only the most recent requests", () => {
    const { updateAnswer } = usePendingUserInputDraftStore.getState();
    for (let index = 0; index < 30; index += 1) {
      updateAnswer(`req-${index}`, "q1", (existing) =>
        togglePendingUserInputOptionSelection(QUESTIONS[0]!, existing, "First"),
      );
    }

    const keys = Object.keys(usePendingUserInputDraftStore.getState().byRequestId);
    expect(keys).toHaveLength(25);
    expect(keys.at(0)).toBe("req-5");
    expect(keys.at(-1)).toBe("req-29");
  });
});
