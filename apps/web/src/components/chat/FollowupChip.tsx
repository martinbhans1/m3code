import { memo } from "react";

import type { FollowupState } from "~/session-logic";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

// Agent-suggested follow-up to-dos, surfaced as chips the user can act on:
// run it now in this thread, spin it off into a brand-new conversation, or
// dismiss it. See deriveFollowups / the suggest_followup MCP tool.
export const FollowupChips = memo(function FollowupChips({
  followups,
  busyId,
  onDoNow,
  onSpinOff,
  onDismiss,
  className,
}: {
  followups: ReadonlyArray<FollowupState>;
  busyId?: string | null;
  onDoNow: (followup: FollowupState) => void;
  onSpinOff: (followup: FollowupState) => void;
  onDismiss: (followup: FollowupState) => void;
  className?: string | undefined;
}) {
  if (followups.length === 0) {
    return null;
  }
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {followups.map((followup) => {
        const busy = busyId === followup.id;
        return (
          <div
            key={followup.id}
            className="rounded-2xl border border-border/80 bg-card/70 p-3 sm:p-3.5"
          >
            <div className="flex min-w-0 items-start gap-2">
              <Badge variant="secondary" className="mt-0.5 shrink-0">
                Follow-up
              </Badge>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{followup.title}</p>
                {followup.detail ? (
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {followup.detail}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDismiss(followup)}>
                Dismiss
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onSpinOff(followup)}
              >
                New conversation
              </Button>
              <Button size="sm" disabled={busy} onClick={() => onDoNow(followup)}>
                Do it now
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
});
