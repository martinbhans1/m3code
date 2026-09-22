import type { VcsStatusResult } from "@t3tools/contracts";

/**
 * The three numbers a "how much work is sitting here?" glance needs, pulled out
 * of the git status we already stream for every repository.
 *
 * `changedFiles` counts working-tree entries (staged or not) — what still needs
 * committing. `ahead`/`behind` are the local divergence against the upstream
 * ref, so they answer "how many commits am I holding" and "how many am I
 * missing" without a network round-trip of their own; the remote-tracking ref
 * they compare against is refreshed by the server's background fetch.
 */
export interface GitCounts {
  /** False when the target directory isn't a repository (or status hasn't loaded). */
  readonly isRepo: boolean;
  /** True once a status snapshot has been received for the target. */
  readonly isKnown: boolean;
  /** Working-tree files with changes — the commit backlog. */
  readonly changedFiles: number;
  /** Commits on the local ref that the upstream doesn't have — the push backlog. */
  readonly ahead: number;
  /** Commits on the upstream that the local ref doesn't have. */
  readonly behind: number;
  /** False when the branch has no upstream, which makes `behind` meaningless. */
  readonly hasUpstream: boolean;
}

export const EMPTY_GIT_COUNTS: GitCounts = Object.freeze({
  isRepo: false,
  isKnown: false,
  changedFiles: 0,
  ahead: 0,
  behind: 0,
  hasUpstream: false,
});

export function deriveGitCounts(status: VcsStatusResult | null | undefined): GitCounts {
  if (!status) {
    return EMPTY_GIT_COUNTS;
  }
  if (!status.isRepo) {
    return { ...EMPTY_GIT_COUNTS, isKnown: true };
  }
  return {
    isRepo: true,
    isKnown: true,
    changedFiles: status.workingTree.files.length,
    ahead: status.aheadCount,
    behind: status.behindCount,
    hasUpstream: status.hasUpstream,
  };
}

/** True when there is nothing worth drawing attention to. */
export function isGitCountsQuiet(counts: GitCounts): boolean {
  return counts.changedFiles === 0 && counts.ahead === 0 && counts.behind === 0;
}

/**
 * Long-form description for tooltips and screen readers. The compact readout is
 * icons and digits by design, so this is where the words live.
 */
export function describeGitCounts(counts: GitCounts): string {
  if (!counts.isKnown) {
    return "Checking git status";
  }
  if (!counts.isRepo) {
    return "Not a git repository";
  }

  const parts: string[] = [
    counts.changedFiles === 1 ? "1 uncommitted file" : `${counts.changedFiles} uncommitted files`,
    counts.ahead === 1 ? "1 commit to push" : `${counts.ahead} commits to push`,
  ];
  if (counts.behind > 0) {
    parts.push(counts.behind === 1 ? "1 commit to pull" : `${counts.behind} commits to pull`);
  }
  if (!counts.hasUpstream) {
    parts.push("no upstream branch");
  }
  return parts.join(" · ");
}
