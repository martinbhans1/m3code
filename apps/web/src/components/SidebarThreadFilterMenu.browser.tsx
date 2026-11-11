import "../index.css";

import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";

const dispatched = vi.hoisted(() => [] as unknown[]);
vi.mock("../environmentApi", () => ({
  readEnvironmentApi: () => ({
    orchestration: {
      dispatchCommand: async (command: unknown) => {
        dispatched.push(command);
      },
    },
  }),
}));

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
    memberProjectRefs: [],
    threads: [],
    tagCounts: new Map([
      ["tickets", 3],
      ["opportunity-detail", 1],
    ]),
  },
  // A project nobody has tagged yet gets no section at all.
  {
    projectKey: "other",
    displayName: "Other",
    vocabulary: [],
    memberProjectRefs: [],
    threads: [],
    tagCounts: new Map(),
  },
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

describe("Manage tags", () => {
  const environmentId = EnvironmentId.make("environment-local");
  const projectId = ProjectId.make("project-dealjourney");
  const synonymProject: SidebarThreadFilterProject = {
    projectKey: "dealjourney",
    displayName: "Deal Journey",
    vocabulary: [
      { name: "support", description: "Customer support" },
      { name: "tickets", description: "Support tickets" },
    ],
    memberProjectRefs: [{ environmentId, projectId }],
    threads: [
      { environmentId, id: ThreadId.make("t-1"), tags: ["support"] },
      { environmentId, id: ThreadId.make("t-2"), tags: ["tickets"] },
    ],
    tagCounts: new Map([
      ["support", 1],
      ["tickets", 1],
    ]),
  };

  beforeEach(() => {
    dispatched.length = 0;
  });
  afterEach(() => cleanup());

  it("merges a synonym into the existing tag by renaming it", async () => {
    await render(<SidebarThreadFilterMenu projects={[synonymProject]} />);
    await page.getByTestId("sidebar-thread-filter-trigger").click();
    await page.getByRole("menuitem", { name: "Manage tags…" }).click();

    const name = page.getByRole("textbox", { name: "Name of tag support" });
    await name.fill("tickets");
    await userEvent.keyboard("{Enter}");

    await expect.poll(() => dispatched.length).toBe(2);
    expect(dispatched).toEqual([
      expect.objectContaining({
        type: "project.meta.update",
        projectId,
        threadTags: [{ name: "tickets", description: "Support tickets" }],
      }),
      expect.objectContaining({
        type: "thread.meta.update",
        threadId: ThreadId.make("t-1"),
        tags: ["tickets"],
      }),
    ]);
  });
});
