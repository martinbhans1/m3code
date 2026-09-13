import "../../index.css";

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import type { ApprovalRequestId } from "@t3tools/contracts";
import type { PendingUserInput } from "../../session-logic";
import {
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
  defaultOptionLabel?: string;
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
      ...(options.defaultOptionLabel ? { defaultOptionLabel: options.defaultOptionLabel } : {}),
    })),
  };
}

function Harness({
  multiSelect,
  questionCount = 1,
  questionIndex = 0,
  onAdvance,
  responseMode,
  defaultOptionLabel,
}: {
  multiSelect: boolean;
  responseMode?: "message";
  defaultOptionLabel?: string;
  questionCount?: number;
  questionIndex?: number;
  onAdvance: () => void;
}) {
  const [input] = useState(() =>
    buildPrompt({
      multiSelect,
      questionCount,
      ...(responseMode ? { responseMode } : {}),
      ...(defaultOptionLabel ? { defaultOptionLabel } : {}),
    }),
  );
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
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
      onAdvance={onAdvance}
    />
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

describe("ComposerPendingUserInputPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lets a multi-select question collect several options without advancing", async () => {
    const onAdvance = vi.fn();
    const screen = await render(<Harness multiSelect onAdvance={onAdvance} />);

    await page.getByRole("checkbox", { name: /Tenant-set customer labels/ }).click();
    await page.getByRole("checkbox", { name: /Translate the portal/ }).click();
    await settle();

    expect(onAdvance).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("checkbox", { name: /Tenant-set customer labels/ }))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByRole("checkbox", { name: /Translate the portal/ }))
      .toHaveAttribute("aria-checked", "true");
    await expect.element(page.getByText("2 selected", { exact: false })).toBeVisible();

    await screen.unmount();
  });

  it("opens a multi-select with every box empty, even when a default is supplied", async () => {
    const onAdvance = vi.fn();
    const screen = await render(
      <Harness multiSelect defaultOptionLabel="Tenant-set customer labels" onAdvance={onAdvance} />,
    );

    for (const option of OPTIONS) {
      await expect
        .element(page.getByRole("checkbox", { name: new RegExp(option.label) }))
        .toHaveAttribute("aria-checked", "false");
    }
    await expect.element(page.getByText("Select one or more options.")).toBeVisible();
    await expect.element(page.getByText("selected —", { exact: false })).not.toBeInTheDocument();

    await screen.unmount();
  });

  it("still shows a single-choice default as already picked", async () => {
    const onAdvance = vi.fn();
    const screen = await render(
      <Harness
        multiSelect={false}
        responseMode="message"
        defaultOptionLabel="Translate the portal"
        onAdvance={onAdvance}
      />,
    );

    await expect
      .element(page.getByRole("radio", { name: /Translate the portal/ }))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByRole("radio", { name: /Tenant-set customer labels/ }))
      .toHaveAttribute("aria-checked", "false");

    await screen.unmount();
  });

  it("does not auto-submit an async choice while the agent continues working", async () => {
    const onAdvance = vi.fn();
    const screen = await render(
      <Harness multiSelect={false} responseMode="message" onAdvance={onAdvance} />,
    );
    await page.getByRole("radio", { name: /Tenant-set customer labels/ }).click();
    await settle();
    expect(onAdvance).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("radio", { name: /Tenant-set customer labels/ }))
      .toHaveAttribute("aria-checked", "true");
    await screen.unmount();
  });

  it("waits for an explicit submit on the last question of a set", async () => {
    const onAdvance = vi.fn();
    const screen = await render(
      <Harness multiSelect={false} questionCount={2} questionIndex={1} onAdvance={onAdvance} />,
    );

    await page.getByRole("radio", { name: /Tenant-set customer labels/ }).click();
    await settle();

    expect(onAdvance).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("radio", { name: /Tenant-set customer labels/ }))
      .toHaveAttribute("aria-checked", "true");

    await screen.unmount();
  });

  it("still sends a lone question straight away", async () => {
    const onAdvance = vi.fn();
    const screen = await render(<Harness multiSelect={false} onAdvance={onAdvance} />);

    await page.getByRole("radio", { name: /Tenant-set customer labels/ }).click();
    await vi.waitFor(() => expect(onAdvance).toHaveBeenCalled());

    await screen.unmount();
  });

  it("still skips ahead when a single-select question has more to come", async () => {
    const onAdvance = vi.fn();
    const screen = await render(
      <Harness multiSelect={false} questionCount={2} onAdvance={onAdvance} />,
    );

    await page.getByRole("radio", { name: /Tenant-set customer labels/ }).click();
    await vi.waitFor(() => expect(onAdvance).toHaveBeenCalled());

    await screen.unmount();
  });
});
