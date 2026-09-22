import type { VcsStatusResult } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  EMPTY_GIT_COUNTS,
  deriveGitCounts,
  describeGitCounts,
  isGitCountsQuiet,
} from "./gitCounts.js";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: true,
    refName: "main",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

function files(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    path: `src/file-${index}.ts`,
    insertions: 1,
    deletions: 0,
  }));
}

describe("deriveGitCounts", () => {
  it("reports nothing known before a status snapshot arrives", () => {
    assert.deepStrictEqual(deriveGitCounts(null), EMPTY_GIT_COUNTS);
    assert.strictEqual(deriveGitCounts(null).isKnown, false);
  });

  it("marks a non-repository as known so the readout can stay hidden", () => {
    const counts = deriveGitCounts(status({ isRepo: false }));
    assert.strictEqual(counts.isKnown, true);
    assert.strictEqual(counts.isRepo, false);
  });

  it("counts working tree files rather than insertions", () => {
    const counts = deriveGitCounts(
      status({
        hasWorkingTreeChanges: true,
        workingTree: { files: files(12), insertions: 480, deletions: 96 },
        aheadCount: 3,
        behindCount: 2,
      }),
    );
    assert.strictEqual(counts.changedFiles, 12);
    assert.strictEqual(counts.ahead, 3);
    assert.strictEqual(counts.behind, 2);
  });
});

describe("isGitCountsQuiet", () => {
  it("is quiet only when every number is zero", () => {
    assert.strictEqual(isGitCountsQuiet(deriveGitCounts(status())), true);
    assert.strictEqual(isGitCountsQuiet(deriveGitCounts(status({ aheadCount: 1 }))), false);
    assert.strictEqual(isGitCountsQuiet(deriveGitCounts(status({ behindCount: 1 }))), false);
    assert.strictEqual(
      isGitCountsQuiet(
        deriveGitCounts(
          status({
            hasWorkingTreeChanges: true,
            workingTree: { files: files(1), insertions: 1, deletions: 0 },
          }),
        ),
      ),
      false,
    );
  });
});

describe("describeGitCounts", () => {
  it("singularises both counters", () => {
    const counts = deriveGitCounts(
      status({
        hasWorkingTreeChanges: true,
        workingTree: { files: files(1), insertions: 1, deletions: 0 },
        aheadCount: 1,
      }),
    );
    assert.strictEqual(describeGitCounts(counts), "1 uncommitted file · 1 commit to push");
  });

  it("mentions incoming commits only when the branch is behind", () => {
    assert.strictEqual(
      describeGitCounts(deriveGitCounts(status({ aheadCount: 2 }))),
      "0 uncommitted files · 2 commits to push",
    );
    assert.strictEqual(
      describeGitCounts(deriveGitCounts(status({ aheadCount: 2, behindCount: 5 }))),
      "0 uncommitted files · 2 commits to push · 5 commits to pull",
    );
  });

  it("calls out a branch that has no upstream to compare against", () => {
    assert.strictEqual(
      describeGitCounts(deriveGitCounts(status({ hasUpstream: false, aheadCount: 4 }))),
      "0 uncommitted files · 4 commits to push · no upstream branch",
    );
  });

  it("explains the states where there are no numbers to show", () => {
    assert.strictEqual(describeGitCounts(deriveGitCounts(null)), "Checking git status");
    assert.strictEqual(
      describeGitCounts(deriveGitCounts(status({ isRepo: false }))),
      "Not a git repository",
    );
  });
});
