import { useEffect, useState } from "react";

import type { ProjectId } from "@t3tools/contracts";

import type { FollowupState } from "~/session-logic";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import type { FollowupProjectChoice } from "./FollowupChipDeck";

export interface FollowupCustomStartOptions {
  /** Free text the user added; folded into the prompt under its own heading. */
  extraContext: string;
  worktree: boolean;
  projectId: ProjectId | null;
  /**
   * Write a handoff link on both threads and badge this one in the sidebar, so
   * a conversation whose work has genuinely moved on reads that way at a glance
   * without being archived.
   */
  markHandoff: boolean;
}

type Destination = "local" | "worktree" | `project:${string}`;

/**
 * The long form of "Start locally". A follow-up is written by the agent in a
 * sentence or two, which is frequently not enough to open a conversation with —
 * this is where the missing context gets added, and where you say that this
 * conversation is finished with the work.
 */
export function FollowupCustomStartDialog({
  followup,
  open,
  onOpenChange,
  canStartInWorktree,
  projectChoices,
  onStart,
}: {
  followup: FollowupState | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canStartInWorktree: boolean;
  projectChoices?: ReadonlyArray<FollowupProjectChoice> | undefined;
  onStart: (followup: FollowupState, options: FollowupCustomStartOptions) => void;
}) {
  const hasProjectChoices = projectChoices !== undefined && projectChoices.length > 0;
  const firstProjectId = projectChoices?.[0]?.id ?? null;
  const [extraContext, setExtraContext] = useState("");
  const [destination, setDestination] = useState<Destination>("local");
  const [markHandoff, setMarkHandoff] = useState(false);

  // Each follow-up gets a clean form. Carrying the previous one's context or
  // checkbox over is the kind of thing you only notice after it has already
  // been sent into a new conversation.
  //
  // Deps are the first project *id*, never the `projectChoices` array itself:
  // on an orchestrator thread that array is memoized on `activeThread`, whose
  // identity changes on every websocket update, so depending on it would wipe
  // whatever the user was typing the moment any activity arrived.
  useEffect(() => {
    if (open) {
      setExtraContext("");
      setDestination(firstProjectId !== null ? `project:${firstProjectId}` : "local");
      setMarkHandoff(false);
    }
  }, [open, followup?.id, firstProjectId]);

  if (!followup) {
    return null;
  }

  const submit = () => {
    onOpenChange(false);
    onStart(followup, {
      extraContext,
      worktree: destination === "worktree",
      projectId: destination.startsWith("project:")
        ? (destination.slice("project:".length) as ProjectId)
        : null,
      markHandoff,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader className="gap-1.5 pe-10">
          <DialogDescription className="text-xs">Start suggested task</DialogDescription>
          <DialogTitle>{followup.title}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="followup-extra-context">Additional context</Label>
            <textarea
              id="followup-extra-context"
              value={extraContext}
              onChange={(event) => setExtraContext(event.target.value)}
              rows={5}
              autoFocus
              placeholder="Anything the suggestion is missing — constraints, the file to start from, what not to touch…"
              className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <p className="text-xs text-muted-foreground">
              Sent as your own note on top of the suggestion, and told to take precedence over it.
            </p>
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Where</legend>
            {hasProjectChoices ? (
              projectChoices.map((project) => (
                <label
                  key={project.id}
                  className="flex items-center gap-2.5 text-sm hover:cursor-pointer"
                >
                  <input
                    type="radio"
                    name="followup-destination"
                    className="size-4 accent-primary"
                    checked={destination === `project:${project.id}`}
                    onChange={() => setDestination(`project:${project.id}`)}
                  />
                  <span>{project.name}</span>
                </label>
              ))
            ) : (
              <>
                <label className="flex items-center gap-2.5 text-sm hover:cursor-pointer">
                  <input
                    type="radio"
                    name="followup-destination"
                    className="size-4 accent-primary"
                    checked={destination === "local"}
                    onChange={() => setDestination("local")}
                  />
                  <span>
                    In this checkout
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      shares the working tree with this conversation
                    </span>
                  </span>
                </label>
                {canStartInWorktree ? (
                  <label className="flex items-center gap-2.5 text-sm hover:cursor-pointer">
                    <input
                      type="radio"
                      name="followup-destination"
                      className="size-4 accent-primary"
                      checked={destination === "worktree"}
                      onChange={() => setDestination("worktree")}
                    />
                    <span>
                      In a new worktree
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        isolated; cannot disturb this one
                      </span>
                    </span>
                  </label>
                ) : null}
              </>
            )}
          </fieldset>

          <label className="flex items-start gap-2.5 text-sm hover:cursor-pointer">
            <Checkbox
              checked={markHandoff}
              onCheckedChange={(checked) => setMarkHandoff(Boolean(checked))}
              className="mt-0.5"
            />
            <span>
              Mark this conversation as handed off
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Adds a link to the new conversation at the end of this one and flags it in the
                sidebar, so you know you can look away from it. Nothing is archived.
              </span>
            </span>
          </label>
        </DialogPanel>
        <DialogFooter variant="bare" className="flex-row items-center justify-end">
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit}>
            Start
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
