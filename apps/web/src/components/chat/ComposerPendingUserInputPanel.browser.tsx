import "../../index.css";

import { useState } from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import type { ApprovalRequestId } from "@t3tools/contracts";
import type { PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const OPTIONS = [
  { label: "Tenant-set customer labels", description: "Like Intercom." },
  { label: "Translate the portal", description: "Run it through i18n." },
  { label: "Show the agent's name", description: "Replace Support." },
];

function buildPrompt(options: {
  multiSelect: boolean;
  questionCount: number;
  responseMode?: "message";
  legacySuggestion?: string;
}): PendingUserInput {
  return {
    requestId: "req-1" as ApprovalRequestId,
    createdAt: new Date(0).toISOString(),
    ...(options.responseMode ? { responseMode: options.responseMode } : {}),
    questions: Array.from({ length: options.questionCount }, (_, index) => ({
      id: `q${index + 1}`,
      header: `QUESTION ${index + 1}`,
      question: `What do you want? (${index + 1})`,
      multiSelect: options.multiSelect,
      options: OPTIONS,
      // Older Codex questions carried a suggested first option. It must never
      // turn into a pick.
      ...(options.legacySuggestion ? { defaultOptionLabel: options.legacySuggestion } : {}),
    })),
  };
}

// Mirrors how the conversation view owns the draft, and exposes what "advance"
// would currently do, so tests can assert nothing is answered behind the user.
let latestAnswers: Record<string, PendingUserInputDraftAnswer> = {};

function Harness({
  multiSelect,
  questionCount = 1,
  questionIndex = 0,
  responseMode,
  legacySuggestion,
}: {
  multiSelect: boolean;
  responseMode?: "message";
  legacySuggestion?: string;
  questionCount?: number;
  questionIndex?: number;
}) {
  const [input] = useState(() =>
    buildPrompt({
      multiSelect,
      questionCount,
      ...(responseMode ? { responseMode } : {}),
      ...(legacySuggestion ? { legacySuggestion } : {}),
    }),
  );
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  latestAnswers = answers;
  return (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[input]}
      isResponding={false}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={(questionId, optionLabel) => {
        const question = input.questions.find((entry) => entry.id === questionId);
        if (!question) return;
        setAnswers((existing) => ({
          ...existing,
          [questionId]: togglePendingUserInputOptionSelection(
            question,
            existing[questionId],
            optionLabel,
          ),
        }));
      }}
    />
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

async function expectAllUnchecked(role: "checkbox" | "radio") {
  for (const option of OPTIONS) {
    await expect
      .element(page.getByRole(role, { name: new RegExp(option.label) }))
      .toHaveAttribute("aria-checked", "false");
  }
}

describe("ComposerPendingUserInputPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    latestAnswers = {};
  });

  it("lets a multi-select question collect several options", async () => {
    const screen = await render(<Harness multiSelect />);

    await page.getByRole("checkbox", { name: /Tenant-set customer labels/ }).click();
    await page.getByRole("checkbox", { name: /Translate the portal/ }).click();
    await settle();

    await expect
      .element(page.getByRole("checkbox", { name: /Tenant-set customer labels/ }))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByRole("checkbox", { name: /Translate the portal/ }))
      .toHaveAttribute("aria-checked", "true");
    await expect.element(page.getByText("2 selected", { exact: false })).toBeVisible();

    await screen.unmount();
  });

  for (const multiSelect of [true, false]) {
    const role = multiSelect ? "checkbox" : "radio";
    const kind = multiSelect ? "multi-select" : "single-choice";

    it(`opens a ${kind} question with nothing picked, even with an old suggestion`, async () => {
      const screen = await render(
        <Harness
          multiSelect={multiSelect}
          responseMode="message"
          legacySuggestion="Tenant-set customer labels"
        />,
      );

      await expectAllUnchecked(role);
      if (multiSelect) {
        await expect.element(page.getByText("Select one or more options.")).toBeVisible();
      }
      const question = buildPrompt({ multiSelect, questionCount: 1 }).questions;
      expect(derivePendingUserInputProgress(question, latestAnswers, 0).canAdvance).toBe(false);

      await screen.unmount();
    });

    it(`lets a ${kind} pick be clicked off again`, async () => {
      const screen = await render(<Harness multiSelect={multiSelect} />);
      const first = page.getByRole(role, { name: /Tenant-set customer labels/ });

      await first.click();
      await expect.element(first).toHaveAttribute("aria-checked", "true");
      await first.click();
      await settle();

      await expectAllUnchecked(role);
      expect(latestAnswers.q1?.selectedOptionLabels ?? []).toEqual([]);

      await screen.unmount();
    });
  }

  it("never moves on or sends when an option is clicked", async () => {
    for (const questionCount of [1, 2]) {
      const screen = await render(<Harness multiSelect={false} questionCount={questionCount} />);
      await page.getByRole("radio", { name: /Tenant-set customer labels/ }).click();
      await settle();

      // Still on the first question, with the pick shown and nothing else changed.
      await expect.element(page.getByText("What do you want? (1)")).toBeVisible();
      await expect
        .element(page.getByRole("radio", { name: /Tenant-set customer labels/ }))
        .toHaveAttribute("aria-checked", "true");
      await screen.unmount();
      latestAnswers = {};
    }
  });

  it("toggles on a number key without moving on", async () => {
    const screen = await render(<Harness multiSelect={false} questionCount={2} />);

    await userEvent.keyboard("1");
    await settle();
    await expect
      .element(page.getByRole("radio", { name: /Tenant-set customer labels/ }))
      .toHaveAttribute("aria-checked", "true");
    await expect.element(page.getByText("What do you want? (1)")).toBeVisible();

    await userEvent.keyboard("1");
    await settle();
    await expectAllUnchecked("radio");

    await screen.unmount();
  });
});
