import "../../index.css";

import { EnvironmentId, type MessageId, type TurnId } from "@t3tools/contracts";
import { createRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { TurnDiffSummary } from "../../types";

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");

  function LegendList(props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => React.ReactNode;
    ListHeaderComponent?: React.ReactNode;
    ListFooterComponent?: React.ReactNode;
    ref?: React.Ref<LegendListRef>;
  }) {
    React.useImperativeHandle(
      props.ref,
      () =>
        ({ scrollToEnd: vi.fn(), getState: () => ({ isAtEnd: true }) }) as unknown as LegendListRef,
    );
    return (
      <div data-testid="legend-list">
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  }

  return { LegendList };
});

import { MessagesTimeline } from "./MessagesTimeline";

const CREATED_AT = "2026-04-13T12:00:00.000Z";
const ASSISTANT_MESSAGE_ID = "message-assistant-1" as MessageId;

const SUMMARY: TurnDiffSummary = {
  turnId: "turn-1" as TurnId,
  completedAt: CREATED_AT,
  assistantMessageId: ASSISTANT_MESSAGE_ID,
  files: Array.from({ length: 8 }, (_, index) => ({
    path: `apps/web/src/components/Example${index}.tsx`,
    additions: 20,
    deletions: 9,
  })),
};

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    latestTurn: null,
    turnDiffSummaryByAssistantMessageId: new Map([[ASSISTANT_MESSAGE_ID, SUMMARY]]),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: vi.fn(),
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: vi.fn(),
    isRevertingCheckpoint: false,
    onImageExpand: vi.fn(),
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    resolvedTheme: "dark" as const,
    timestampFormat: "24-hour" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: vi.fn(),
    // Two user prompts, so the prompt navigator's buttons can actually be
    // enabled — a disabled button is not hit-testable and would make the
    // overlap assertions meaningless.
    timelineEntries: [
      {
        id: "entry-1",
        kind: "message" as const,
        createdAt: CREATED_AT,
        message: {
          id: "message-1" as MessageId,
          role: "user" as const,
          text: "what i'm imagining one thing i'm kind of envisioning for myself here which would be cool is to do something like what we've done in or what codex does",
          createdAt: CREATED_AT,
          streaming: false,
        },
      },
      {
        id: "entry-2",
        kind: "message" as const,
        createdAt: CREATED_AT,
        message: {
          id: ASSISTANT_MESSAGE_ID,
          role: "assistant" as const,
          text: "If you want the sidebar to actually be the darkest surface, that's a one-line tweak.",
          createdAt: CREATED_AT,
          streaming: false,
        },
      },
      {
        id: "entry-3",
        kind: "message" as const,
        createdAt: CREATED_AT,
        message: {
          id: "message-2" as MessageId,
          role: "user" as const,
          text: "second prompt so the navigator has somewhere to go",
          createdAt: CREATED_AT,
          streaming: false,
        },
      },
    ],
  };
}

function rect(element: Element | null) {
  if (!element) throw new Error("expected element to be present");
  return element.getBoundingClientRect();
}

function overlaps(a: DOMRect, b: DOMRect) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** The element the user's click would actually land on at a point. */
function hitTarget(x: number, y: number) {
  return document.elementFromPoint(x, y);
}

describe("MessagesTimeline top overlay row", () => {
  beforeEach(() => {
    localStorage.removeItem("t3code:changed-files-hidden");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem("t3code:changed-files-hidden");
    document.body.innerHTML = "";
  });

  it("keeps the changed-files panel clear of the prompt navigator at a narrow width", async () => {
    await page.viewport(620, 780);
    const screen = await render(<MessagesTimeline {...buildProps()} />);

    try {
      // Step back a prompt so "Next prompt" is enabled and clickable.
      await page.getByLabelText("Previous prompt").click();
      const nextPrompt = page.getByLabelText("Next prompt");
      await expect.element(nextPrompt).toBeVisible();
      expect(document.querySelector('[aria-label="Next prompt"]')?.hasAttribute("disabled")).toBe(
        false,
      );

      const navRect = rect(document.querySelector('[aria-label="Next prompt"]'));
      const changedFiles = document.querySelector('[title="Show changed files"]');
      const changedRect = rect(changedFiles);

      expect(overlaps(navRect, changedRect)).toBe(false);

      // The regression was that the changed-files chip sat on top of this
      // button, so the click never reached it.
      const target = hitTarget(navRect.left + navRect.width / 2, navRect.top + navRect.height / 2);
      expect(target && changedFiles?.contains(target)).toBeFalsy();
      expect(document.querySelector('[aria-label="Next prompt"]')?.contains(target)).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("hides the changed-files panel and offers a control to bring it back", async () => {
    await page.viewport(1100, 780);
    const screen = await render(<MessagesTimeline {...buildProps()} />);

    try {
      await expect.element(page.getByLabelText("Hide changed files")).toBeVisible();
      await page.getByLabelText("Hide changed files").click();

      expect(document.querySelector('[title="Show changed files"]')).toBeNull();
      expect(localStorage.getItem("t3code:changed-files-hidden")).toBe("true");

      const restore = page.getByLabelText("Show changed files (8)");
      await expect.element(restore).toBeVisible();
      await restore.click();

      await expect.element(page.getByLabelText("Hide changed files")).toBeVisible();
      expect(localStorage.getItem("t3code:changed-files-hidden")).toBe("false");
    } finally {
      await screen.unmount();
    }
  });
});
