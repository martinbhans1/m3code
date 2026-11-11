import "../index.css";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";

import { useSidebarThreadFilterStore } from "../sidebarThreadFilter";
import {
  SidebarThreadFilterMenu,
  type SidebarThreadFilterProject,
} from "./SidebarThreadFilterMenu";

const projects: SidebarThreadFilterProject[] = [
  {
    projectKey: "dealjourney",
    displayName: "Deal Journey",
    vocabulary: [
      { name: "opportunity-detail", description: "The single-opportunity page" },
      { name: "tickets", description: "Support tickets" },
    ],
    tagCounts: new Map([
      ["tickets", 3],
      ["opportunity-detail", 1],
    ]),
  },
  // A project nobody has tagged yet gets no section at all.
  { projectKey: "other", displayName: "Other", vocabulary: [], tagCounts: new Map() },
];

describe("SidebarThreadFilterMenu", () => {
  beforeEach(() => {
    useSidebarThreadFilterStore.setState({ hideCompleted: true, selectedTagsByProject: {} });
  });
  afterEach(() => cleanup());

  it("hides completed by default and lists the project's tags with counts", async () => {
    await render(<SidebarThreadFilterMenu projects={projects} />);
    await page.getByTestId("sidebar-thread-filter-trigger").click();

    const hideCompleted = page.getByRole("menuitemcheckbox", { name: "Hide completed" });
    await expect.element(hideCompleted).toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: /tickets/ }))
      .toHaveTextContent("3");
    expect(page.getByText("Tags · Other").elements()).toHaveLength(0);

    await hideCompleted.click();
    expect(useSidebarThreadFilterStore.getState().hideCompleted).toBe(false);
  });

  it("narrows a project to the tags the user ticks, and clears them", async () => {
    await render(<SidebarThreadFilterMenu projects={projects} />);
    await page.getByTestId("sidebar-thread-filter-trigger").click();
    await page.getByRole("menuitemcheckbox", { name: /tickets/ }).click();
    expect(useSidebarThreadFilterStore.getState().selectedTagsByProject).toEqual({
      dealjourney: ["tickets"],
    });

    await page.getByRole("menuitem", { name: "Clear tag filters" }).click();
    expect(useSidebarThreadFilterStore.getState().selectedTagsByProject).toEqual({});
  });
});
