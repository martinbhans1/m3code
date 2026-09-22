import "../index.css";

import { EnvironmentId, type VcsStatusResult } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { BranchToolbarGitCounts } from "./BranchToolbarGitCounts";

const status = vi.hoisted(() => ({
  current: null as VcsStatusResult | null,
}));

vi.mock("../lib/vcsStatusState", () => ({
  useVcsStatus: () => ({
    targetKey: "environment-local:/repo/project",
    data: status.current,
    error: null,
    cause: null,
    isPending: status.current === null,
  }),
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function vcsStatus(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: true,
    refName: "main",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

function changedFiles(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    path: `src/file-${index}.ts`,
    insertions: 2,
    deletions: 1,
  }));
}

describe("BranchToolbarGitCounts", () => {
  beforeEach(() => {
    status.current = null;
  });

  it("renders the uncommitted and unpushed counts", async () => {
    status.current = vcsStatus({
      hasWorkingTreeChanges: true,
      workingTree: { files: changedFiles(17), insertions: 400, deletions: 120 },
      aheadCount: 4,
    });

    const screen = await render(
      <BranchToolbarGitCounts environmentId={ENVIRONMENT_ID} cwd="/repo/project" />,
    );

    const readout = screen.container.querySelector<HTMLElement>("[aria-label]");
    expect(readout?.getAttribute("aria-label")).toBe("17 uncommitted files · 4 commits to push");
    expect(readout?.textContent).toContain("17");
    expect(readout?.textContent).toContain("4");
    // No incoming commits, so the third counter stays out of the way.
    expect(readout?.textContent).not.toContain("commits to pull");
  });

  it("adds the incoming counter only when the branch is behind", async () => {
    status.current = vcsStatus({ aheadCount: 1, behindCount: 9 });

    const screen = await render(
      <BranchToolbarGitCounts environmentId={ENVIRONMENT_ID} cwd="/repo/project" />,
    );

    const readout = screen.container.querySelector<HTMLElement>("[aria-label]");
    expect(readout?.getAttribute("aria-label")).toBe(
      "0 uncommitted files · 1 commit to push · 9 commits to pull",
    );
    expect(readout?.textContent).toContain("9");
  });

  it("renders nothing before a status snapshot arrives", async () => {
    const screen = await render(
      <BranchToolbarGitCounts environmentId={ENVIRONMENT_ID} cwd="/repo/project" />,
    );

    expect(screen.container.textContent).toBe("");
  });

  it("renders nothing for a directory that is not a repository", async () => {
    status.current = vcsStatus({ isRepo: false });

    const screen = await render(
      <BranchToolbarGitCounts environmentId={ENVIRONMENT_ID} cwd="/repo/project" />,
    );

    expect(screen.container.textContent).toBe("");
  });
});
