import "../../index.css";

import { useState } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, render } from "vitest-browser-react";

import { ProjectId } from "@t3tools/contracts";

import { FollowupChipDeck, type FollowupProjectChoice } from "./FollowupChipDeck";
import type { FollowupState } from "~/session-logic";

function makeFollowup(
  overrides: Partial<FollowupState> & Pick<FollowupState, "id">,
): FollowupState {
  return {
    title: `Follow-up ${overrides.id}`,
    detail: null,
    rationale: null,
    status: "pending",
    turnId: null,
    createdAt: "2026-08-03T10:00:00.000Z",
    updatedAt: "2026-08-03T10:00:00.000Z",
    ...overrides,
  };
}

const THREE = [
  makeFollowup({
    id: "a",
    title: "Fix timeline scroll jump on streaming appends",
    detail: "The chat timeline jumps slightly while an assistant message streams in.",
  }),
  makeFollowup({ id: "b", title: "Normalize thread activity timestamps to UTC" }),
  makeFollowup({ id: "c", title: "Clean up stale pre-rebrand product name strings" }),
];

function renderDeck(overrides?: {
  followups?: ReadonlyArray<FollowupState>;
  canStartInWorktree?: boolean;
  projectChoices?: ReadonlyArray<FollowupProjectChoice>;
}) {
  const onStartLocally = vi.fn<(followup: FollowupState) => void>();
  const onStartInWorktree = vi.fn<(followup: FollowupState) => void>();
  const onStartCustom = vi.fn<(followup: FollowupState) => void>();
  const onFixInSession = vi.fn<(followup: FollowupState) => void>();
  const onStartInProject = vi.fn<(followup: FollowupState, projectId: ProjectId) => void>();
  const onDismiss = vi.fn<(followup: FollowupState) => void>();
  render(
    <div style={{ position: "relative", height: "400px", width: "900px" }}>
      <FollowupChipDeck
        followups={overrides?.followups ?? THREE}
        canStartInWorktree={overrides?.canStartInWorktree ?? true}
        projectChoices={overrides?.projectChoices}
        onStartLocally={onStartLocally}
        onStartInWorktree={onStartInWorktree}
        onStartCustom={onStartCustom}
        onFixInSession={onFixInSession}
        onStartInProject={onStartInProject}
        onDismiss={onDismiss}
      />
    </div>,
  );
  return {
    onStartLocally,
    onStartInWorktree,
    onStartCustom,
    onFixInSession,
    onStartInProject,
    onDismiss,
  };
}

describe("FollowupChipDeck", () => {
  // The test browser renders into a narrow frame, which is below the mobile
  // breakpoint — so the deck would default to its collapsed pill. Most cases
  // here are about the card, so opt them into the expanded state explicitly.
  beforeEach(() => {
    window.localStorage.setItem("m3code:followup-deck-collapsed", "false");
  });

  afterEach(() => {
    cleanup();
  });

  it("defaults to the pill on a narrow viewport", async () => {
    window.localStorage.removeItem("m3code:followup-deck-collapsed");
    renderDeck();

    await expect
      .element(page.getByRole("button", { name: "Show 3 suggested tasks" }))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("Start locally");
  });

  it("collapses to a counted pill and restores the card", async () => {
    renderDeck();

    await expect.element(page.getByRole("button", { name: "Hide suggested tasks" })).toBeVisible();
    await page.getByRole("button", { name: "Hide suggested tasks" }).click();

    // Collapsed: only the pill, carrying how many are waiting.
    const pill = page.getByRole("button", { name: "Show 3 suggested tasks" });
    await expect.element(pill).toBeVisible();
    expect(document.body.textContent).not.toContain("Start locally");
    expect(window.localStorage.getItem("m3code:followup-deck-collapsed")).toBe("true");

    await pill.click();
    await expect.element(page.getByRole("button", { name: "Start locally" })).toBeVisible();
    expect(window.localStorage.getItem("m3code:followup-deck-collapsed")).toBe("false");
  });

  it("starts collapsed when a previous session hid the deck", async () => {
    window.localStorage.setItem("m3code:followup-deck-collapsed", "true");
    renderDeck();

    await expect
      .element(page.getByRole("button", { name: "Show 3 suggested tasks" }))
      .toBeVisible();
  });

  it("shows the first of a stack and pages through with the arrows", async () => {
    renderDeck();

    await expect.element(page.getByText("Suggested task")).toBeVisible();
    await expect.element(page.getByText("1 of 3")).toBeVisible();
    await expect
      .element(page.getByText("Fix timeline scroll jump on streaming appends"))
      .toBeVisible();

    await page.getByRole("button", { name: "Next suggested task" }).click();
    await expect.element(page.getByText("2 of 3")).toBeVisible();
    await expect
      .element(page.getByText("Normalize thread activity timestamps to UTC"))
      .toBeVisible();

    await page.getByRole("button", { name: "Next suggested task" }).click();
    await expect.element(page.getByText("3 of 3")).toBeVisible();
    // At the end of the deck forward navigation is unavailable.
    await expect.element(page.getByRole("button", { name: "Next suggested task" })).toBeDisabled();

    await page.getByRole("button", { name: "Previous suggested task" }).click();
    await expect.element(page.getByText("2 of 3")).toBeVisible();
  });

  it("hides the counter for a single follow-up", async () => {
    renderDeck({ followups: [THREE[0]!] });

    await expect.element(page.getByText("Suggested task")).toBeVisible();
    expect(document.body.textContent).not.toContain("1 of 1");
  });

  it("starts locally as the primary action and dismisses the shown card", async () => {
    const { onStartLocally, onDismiss } = renderDeck();

    await page.getByRole("button", { name: "Start locally" }).click();
    expect(onStartLocally).toHaveBeenCalledTimes(1);
    expect(onStartLocally.mock.calls[0]?.[0]?.id).toBe("a");

    await page.getByRole("button", { name: "Dismiss suggested task" }).click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss.mock.calls[0]?.[0]?.id).toBe("a");
  });

  it("offers the alternate start modes in the split-button menu", async () => {
    const { onFixInSession } = renderDeck();

    await page.getByRole("button", { name: "More ways to start this task" }).click();
    await expect.element(page.getByText("Start in a worktree")).toBeVisible();
    await page.getByText("Fix in this session").click();
    expect(onFixInSession).toHaveBeenCalledTimes(1);
  });

  it("omits the worktree option when the project cannot support one", async () => {
    renderDeck({ canStartInWorktree: false });

    await page.getByRole("button", { name: "More ways to start this task" }).click();
    await expect.element(page.getByText("Fix in this session")).toBeVisible();
    expect(document.body.textContent).not.toContain("Start in a worktree");
  });

  it("asks which project to start in when the thread has no project of its own", async () => {
    // The orchestrator case: starting the work "here" would open a second
    // orchestrator conversation, so the deck offers the real projects instead.
    const { onStartInProject, onStartLocally } = renderDeck({
      projectChoices: [
        { id: ProjectId.make("project-dealjourney"), name: "dealjourney" },
        { id: ProjectId.make("project-m3code"), name: "m3code" },
      ],
    });

    expect(document.body.textContent).not.toContain("Start locally");
    await page.getByRole("button", { name: "Start in…" }).click();
    await page.getByText("m3code").click();

    expect(onStartLocally).not.toHaveBeenCalled();
    expect(onStartInProject).toHaveBeenCalledTimes(1);
    expect(onStartInProject.mock.calls[0]?.[0]?.id).toBe("a");
    expect(onStartInProject.mock.calls[0]?.[1]).toBe("project-m3code");
  });

  it("opens the full description in a dialog", async () => {
    renderDeck({
      followups: [
        makeFollowup({
          id: "a",
          title: "Team chat fires a failing POST /admin-chat/categories on load",
          detail: [
            "Opening `/team-chat` fires a `POST /routes/admin-chat/categories` that comes back **400** every time. It is already being captured by the error reporter, so it is polluting `/platform_errors` on every page load.",
            "Spotted while checking the console during the realtime sweep — unrelated to that change, and the sidebar still renders fine, so it looks like a redundant category-creation attempt rather than a broken feature.",
          ].join("\n\n"),
          rationale:
            "A guaranteed 400 on every page load makes the error log much noisier and harder to triage.",
        }),
      ],
    });

    await page.getByRole("button", { name: "Open full description" }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.element(page.getByRole("dialog").getByText("Why:")).toBeVisible();
  });

  it("falls back to the last card when the shown one is resolved away", async () => {
    // Mirrors the live case: the deck is paged to the end, then the server
    // resolves follow-ups out from under it and the list shrinks.
    function Harness() {
      const [followups, setFollowups] = useState<ReadonlyArray<FollowupState>>(THREE);
      return (
        <div style={{ position: "relative", height: "400px", width: "900px" }}>
          <button type="button" onClick={() => setFollowups([THREE[0]!])}>
            shrink
          </button>
          <FollowupChipDeck
            followups={followups}
            canStartInWorktree
            onStartLocally={vi.fn()}
            onStartInWorktree={vi.fn()}
            onStartCustom={vi.fn()}
            onFixInSession={vi.fn()}
            onStartInProject={vi.fn()}
            onDismiss={vi.fn()}
          />
        </div>
      );
    }
    render(<Harness />);

    await page.getByRole("button", { name: "Next suggested task" }).click();
    await page.getByRole("button", { name: "Next suggested task" }).click();
    await expect.element(page.getByText("3 of 3")).toBeVisible();

    await page.getByRole("button", { name: "shrink" }).click();

    await expect
      .element(page.getByText("Fix timeline scroll jump on streaming appends"))
      .toBeVisible();
  });
});
