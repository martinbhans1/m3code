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
    // Two user prompts: the minimap rail only shows from two up.
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

describe("MessagesTimeline top overlay row", () => {
  beforeEach(() => {
    localStorage.removeItem("t3code:changed-files-hidden");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem("t3code:changed-files-hidden");
    document.body.innerHTML = "";
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

  it("previews a prompt and its reply when hovering the minimap rail", async () => {
    await page.viewport(1100, 780);
    const props = buildProps();
    const screen = await render(<MessagesTimeline {...props} />);

    try {
      const minimap = document.querySelector<HTMLElement>('[data-testid="timeline-minimap"]');
      if (!minimap) throw new Error("expected the minimap rail to render");
      // Wide window: the rail sits in the gutter and stays visible.
      await vi.waitFor(() => expect(minimap.dataset.persistentGutter).toBe("true"));

      const rail = page.getByRole("button", { name: /Jump to message/ });
      await rail.hover({ position: { x: 4, y: 0 } });

      await vi.waitFor(() => {
        const preview = document.querySelector("[data-minimap-preview]");
        expect(preview?.textContent ?? "").toContain("what i'm imagining");
        expect(preview?.textContent ?? "").toContain("darkest surface");
      });
    } finally {
      await screen.unmount();
    }
  });
});
