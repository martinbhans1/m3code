import { memo, useState } from "react";
import { ChevronDownIcon } from "lucide-react";

import type { FollowupState } from "~/session-logic";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

// Agent-suggested follow-up to-dos, surfaced as chips the user can act on:
// run it now in this thread, spin it off into a brand-new conversation, or
// dismiss it. See deriveFollowups / the suggest_followup MCP tool.
//
// The detail an agent writes is often a dense paragraph of paths and options,
// so the card stays collapsed to a two-line teaser until expanded; expanding
// renders it as markdown (lists, inline code, clickable file links).
export const FollowupChips = memo(function FollowupChips({
  followups,
  busyId,
  cwd,
  onDoNow,
  onSpinOff,
  onDismiss,
  className,
}: {
  followups: ReadonlyArray<FollowupState>;
  busyId?: string | null;
  cwd?: string | null | undefined;
  onDoNow: (followup: FollowupState) => void;
  onSpinOff: (followup: FollowupState) => void;
  onDismiss: (followup: FollowupState) => void;
  className?: string | undefined;
}) {
  if (followups.length === 0) {
    return null;
  }
  return (
    // Width matches the composer, QueuedTurns and the banner stack (max-w-208)
    // — without it the card stretches the full window and dwarfs the composer.
    <div className={cn("mx-auto flex w-full min-w-0 max-w-208 flex-col gap-2", className)}>
      {followups.map((followup) => (
        <FollowupChipCard
          key={followup.id}
          followup={followup}
          busy={busyId === followup.id}
          cwd={cwd ?? undefined}
          onDoNow={onDoNow}
          onSpinOff={onSpinOff}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
});

function FollowupChipCard({
  followup,
  busy,
  cwd,
  onDoNow,
  onSpinOff,
  onDismiss,
}: {
  followup: FollowupState;
  busy: boolean;
  cwd: string | undefined;
  onDoNow: (followup: FollowupState) => void;
  onSpinOff: (followup: FollowupState) => void;
  onDismiss: (followup: FollowupState) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detail = followup.detail?.trim() ?? "";
  const rationale = followup.rationale?.trim() ?? "";
  const expandable = detail.length > 0 || rationale.length > 0;

  return (
    <div className="rounded-2xl border border-border/80 bg-card/70 p-3 sm:p-3.5">
      <div className="flex min-w-0 items-start gap-2">
        <Badge variant="secondary" className="mt-0.5 shrink-0">
          Follow-up
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{followup.title}</p>
          {detail.length > 0 && !expanded ? (
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {detail}
            </p>
          ) : null}
        </div>
        {expandable ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? "Hide follow-up details" : "Show follow-up details"}
            onClick={() => setExpanded((value) => !value)}
            className="mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground hover:cursor-pointer"
          >
            <ChevronDownIcon
              className={cn("size-4 transition-transform", expanded && "rotate-180")}
            />
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div className="mt-2 min-w-0 border-t border-border/60 pt-2">
          {detail.length > 0 ? (
            <ChatMarkdown text={detail} cwd={cwd} className="text-xs leading-relaxed" />
          ) : null}
          {rationale.length > 0 ? (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">Why: </span>
              {rationale}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDismiss(followup)}>
          Dismiss
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onSpinOff(followup)}>
          New conversation
        </Button>
        <Button size="sm" disabled={busy} onClick={() => onDoNow(followup)}>
          Do it now
        </Button>
      </div>
    </div>
  );
}
