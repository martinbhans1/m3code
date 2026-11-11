import "../../index.css";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";

const fixture = vi.hoisted(() => ({
  goal: null as string | null,
  doneAt: null as string | null,
  setThreadGoal: vi.fn(async () => {}),
  setThreadDone: vi.fn(async () => {}),
}));

vi.mock("../../store", () => ({
  useStore: (selector: (state: unknown) => unknown) => selector({}),
  selectThreadByRef: () => ({ goal: fixture.goal }),
  selectSidebarThreadSummaryByRef: () => ({ doneAt: fixture.doneAt }),
}));

vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    setThreadGoal: fixture.setThreadGoal,
    setThreadDone: fixture.setThreadDone,
  }),
}));

import { ThreadGoalBar } from "./ThreadGoalBar";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-local"), ThreadId.make("t-1"));

describe("ThreadGoalBar", () => {
  beforeEach(() => {
    fixture.goal = null;
    fixture.doneAt = null;
    fixture.setThreadGoal.mockClear();
    fixture.setThreadDone.mockClear();
  });
  afterEach(() => cleanup());

  it("invites a goal when there is none, and saves what the user types", async () => {
    await render(<ThreadGoalBar threadRef={threadRef} />);
    await page.getByRole("button", { name: "Set a goal for this conversation" }).click();
    const input = page.getByRole("textbox", { name: "Conversation goal" });
    await input.fill("  Ticket list loads in under a second  ");
    await userEvent.keyboard("{Enter}");
    expect(fixture.setThreadGoal).toHaveBeenCalledWith(
      threadRef,
      "Ticket list loads in under a second",
    );
  });

  it("shows the goal, and Escape abandons an edit", async () => {
    fixture.goal = "Ship the importer";
    await render(<ThreadGoalBar threadRef={threadRef} />);
    await expect.element(page.getByText("Ship the importer")).toBeVisible();
    await page.getByRole("button", { name: /Goal: Ship the importer/ }).click();
    await page.getByRole("textbox", { name: "Conversation goal" }).fill("Something else");
    await userEvent.keyboard("{Escape}");
    expect(fixture.setThreadGoal).not.toHaveBeenCalled();
    await expect.element(page.getByText("Ship the importer")).toBeVisible();
  });

  it("clearing the text clears the goal", async () => {
    fixture.goal = "Ship the importer";
    await render(<ThreadGoalBar threadRef={threadRef} />);
    await page.getByRole("button", { name: /Goal: Ship the importer/ }).click();
    await page.getByRole("textbox", { name: "Conversation goal" }).fill("   ");
    await userEvent.keyboard("{Enter}");
    expect(fixture.setThreadGoal).toHaveBeenCalledWith(threadRef, null);
  });

  it("marks the conversation completed", async () => {
    await render(<ThreadGoalBar threadRef={threadRef} />);
    const toggle = page.getByTestId("thread-complete-toggle");
    await expect.element(toggle).toHaveTextContent("Mark completed");
    await toggle.click();
    expect(fixture.setThreadDone).toHaveBeenCalledWith(threadRef, true);
  });

  it("reopens a completed conversation", async () => {
    fixture.doneAt = "2026-11-11T10:00:00.000Z";
    await render(<ThreadGoalBar threadRef={threadRef} />);
    const reopen = page.getByTestId("thread-complete-toggle");
    await expect.element(reopen).toHaveTextContent("Completed");
    await reopen.click();
    expect(fixture.setThreadDone).toHaveBeenCalledWith(threadRef, false);
  });
});
