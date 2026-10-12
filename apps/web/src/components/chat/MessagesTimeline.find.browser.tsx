import "../../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { MessagesTimeline } from "./MessagesTimeline";
import { TIMELINE_FIND_CURRENT_HIGHLIGHT, TIMELINE_FIND_HIGHLIGHT } from "./timelineFind";

const CREATED_AT = "2026-10-12T12:00:00.000Z";

// A long thread whose only mentions of the keyword sit far above the bottom,
// well outside what the virtualized list keeps mounted.
const timelineEntries = Array.from({ length: 80 }, (_, index) => {
  const role = index % 2 === 0 ? ("user" as const) : ("assistant" as const);
  const text =
    index === 6
      ? "Let's talk about the **flux**capacitor before anything else."
      : index === 11
        ? "Fluxcapacitor follow-up."
        : `Message ${index}: ${"ordinary filler text ".repeat(12)}`;
  return {
    id: `entry-${index}`,
    kind: "message" as const,
    createdAt: CREATED_AT,
    message: {
      id: `message-${index}` as never,
      role,
      text,
      createdAt: CREATED_AT,
      streaming: false,
    },
  };
});

afterEach(() => {
  document.body.innerHTML = "";
});

function highlightTexts(name: string): string[] {
  const highlight = CSS.highlights.get(name);
  return highlight ? [...highlight].map((range) => (range as Range).toString()) : [];
}

function Harness(props: {
  onFindClose: () => void;
  initialQuery?: string;
  preferredRowId?: string;
}) {
  const [listRef] = useState(() => createRef<LegendListRef | null>());
  const [query, setQuery] = useState(props.initialQuery ?? "");
  return (
    <div style={{ height: 600, width: 900, display: "flex", flexDirection: "column" }}>
      <MessagesTimeline
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        listRef={listRef}
        timelineEntries={timelineEntries}
        latestTurn={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        routeThreadKey="environment-local:thread-1"
        onOpenTurnDiff={vi.fn()}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={vi.fn()}
        isRevertingCheckpoint={false}
        onImageExpand={vi.fn()}
        activeThreadEnvironmentId={EnvironmentId.make("environment-local")}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
        onIsAtEndChange={vi.fn()}
        findOpen
        findQuery={query}
        onFindQueryChange={setQuery}
        findPreferredRowId={props.preferredRowId ?? null}
        findFocusRequest={1}
        onFindClose={props.onFindClose}
      />
    </div>
  );
}

it("finds a message far up a long conversation, scrolls to it and highlights it", async () => {
  const onFindClose = vi.fn();
  await page.viewport(1200, 800);
  await render(<Harness onFindClose={onFindClose} />);

  // Starts pinned to the bottom, so the keyword's rows are not mounted.
  await expect.poll(() => document.querySelector('[data-timeline-row-id="entry-79"]')).toBeTruthy();
  expect(document.querySelector('[data-timeline-row-id="entry-6"]')).toBeNull();

  const input = page.getByRole("textbox", { name: "Find in conversation" });
  await expect.element(input).toHaveFocus();
  await userEvent.type(input, "fluxcapacitor");

  // Nothing below the viewport top matches, so it lands on the latest match.
  await expect.element(page.getByText("2 of 2")).toBeVisible();
  await expect
    .poll(() => highlightTexts(TIMELINE_FIND_CURRENT_HIGHLIGHT), { timeout: 5000 })
    .toEqual(["Fluxcapacitor"]);

  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  await expect.element(page.getByText("1 of 2")).toBeVisible();
  // Split across bold markup in the rendered markdown, still one highlight.
  await expect
    .poll(() => highlightTexts(TIMELINE_FIND_CURRENT_HIGHLIGHT), { timeout: 5000 })
    .toEqual(["fluxcapacitor"]);
  await expect
    .poll(() => highlightTexts(TIMELINE_FIND_HIGHLIGHT), { timeout: 5000 })
    .toContain("Fluxcapacitor");
  // The scroll animates; wait for the match to settle inside the viewport.
  await expect
    .poll(() => {
      const top = document
        .querySelector('[data-timeline-row-id="entry-6"]')
        ?.getBoundingClientRect().top;
      return top !== undefined && top >= 0 && top < window.innerHeight;
    })
    .toBe(true);

  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("2 of 2")).toBeVisible();

  await userEvent.clear(input);
  await userEvent.type(input, "no such words");
  await expect.element(page.getByText("No results")).toBeVisible();

  await userEvent.keyboard("{Escape}");
  expect(onFindClose).toHaveBeenCalledTimes(1);
});

it("opens on the message a conversation search matched, not the latest match", async () => {
  await page.viewport(1200, 800);
  await render(
    <Harness onFindClose={vi.fn()} initialQuery="fluxcapacitor" preferredRowId="entry-6" />,
  );

  await expect.element(page.getByText("1 of 2")).toBeVisible();
  await expect
    .poll(() => highlightTexts(TIMELINE_FIND_CURRENT_HIGHLIGHT), { timeout: 5000 })
    .toEqual(["fluxcapacitor"]);
});
