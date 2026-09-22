import { deriveGitCounts, describeGitCounts } from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, FileDiffIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { cn } from "../lib/utils";
import { useVcsStatus } from "../lib/vcsStatusState";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface BranchToolbarGitCountsProps {
  environmentId: EnvironmentId;
  cwd: string | null;
  className?: string;
}

function Counter({
  Icon,
  value,
  label,
}: {
  Icon: typeof FileDiffIcon;
  value: number;
  label: string;
}) {
  const isZero = value === 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 tabular-nums",
        isZero ? "text-muted-foreground/40" : "text-foreground/80",
      )}
    >
      <Icon className="size-3 shrink-0 opacity-70" aria-hidden="true" />
      <span className="sr-only">{label}</span>
      {value}
    </span>
  );
}

/**
 * Compact working-tree / unpushed readout for the thread header.
 *
 * The numbers are read straight off the git status stream the toolbar already
 * subscribes to for the branch name, so this adds no git work of its own — it
 * only renders counters that were previously used as booleans to decide which
 * git buttons to enable.
 */
export const BranchToolbarGitCounts = memo(function BranchToolbarGitCounts({
  environmentId,
  cwd,
  className,
}: BranchToolbarGitCountsProps) {
  const statusQuery = useVcsStatus({ environmentId, cwd });
  const counts = useMemo(() => deriveGitCounts(statusQuery.data), [statusQuery.data]);

  // Nothing to say until a snapshot lands, and nothing worth saying for a
  // directory that isn't a repository.
  if (!counts.isKnown || !counts.isRepo) {
    return null;
  }

  const description = describeGitCounts(counts);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={description}
            className={cn(
              "inline-flex shrink-0 items-center gap-2 px-1 text-[11px] leading-none",
              className,
            )}
          />
        }
      >
        <Counter Icon={FileDiffIcon} value={counts.changedFiles} label="uncommitted files" />
        <Counter Icon={ArrowUpIcon} value={counts.ahead} label="commits to push" />
        {counts.behind > 0 ? (
          <Counter Icon={ArrowDownIcon} value={counts.behind} label="commits to pull" />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top">{description}</TooltipPopup>
    </Tooltip>
  );
});
