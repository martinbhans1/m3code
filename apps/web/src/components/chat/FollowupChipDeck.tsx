import { memo, useCallback, useEffect, useState } from "react";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LightbulbIcon,
  Maximize2Icon,
  MinusIcon,
  XIcon,
} from "lucide-react";

import type { ProjectId } from "@t3tools/contracts";

import type { FollowupState } from "~/session-logic";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

/**
 * Agent-suggested follow-ups, surfaced as a floating deck in the top-right of
 * the chat column rather than inline above the composer.
 *
 * The point of a follow-up is that it is deliberately *not* the thing we are
 * working on: it can sit there indefinitely without stealing transcript space
 * or pushing the composer around. The deck stacks the pending ones so a burst
 * of suggestions costs the same screen area as one, and you page through them.
 *
 * It anchors inside the chat column (not the window), so opening the right
 * panel shrinks the column and carries the deck left with it — that is what
 * keeps it from ever colliding with the changed-files surface.
 */
const COLLAPSED_STORAGE_KEY = "m3code:followup-deck-collapsed";

function readStoredCollapsed(): boolean | null {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    return raw === null ? null : raw === "true";
  } catch {
    return null;
  }
}

function writeStoredCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false");
  } catch {
    // Preference only — a blocked storage quota must not break the deck.
  }
}

export interface FollowupProjectChoice {
  id: ProjectId;
  name: string;
}

export interface FollowupDeckActions {
  onStartLocally: (followup: FollowupState) => void;
  onStartInWorktree: (followup: FollowupState) => void;
  onFixInSession: (followup: FollowupState) => void;
  onStartInProject: (followup: FollowupState, projectId: ProjectId) => void;
  /** Opens the long form — extra context, destination, and the handoff mark. */
  onStartCustom: (followup: FollowupState) => void;
  onDismiss: (followup: FollowupState) => void;
}

export const FollowupChipDeck = memo(function FollowupChipDeck({
  followups,
  busyId,
  cwd,
  canStartInWorktree,
  projectChoices,
  className,
  ...actions
}: FollowupDeckActions & {
  followups: ReadonlyArray<FollowupState>;
  busyId?: string | null;
  cwd?: string | null | undefined;
  canStartInWorktree: boolean;
  /**
   * Projects the follow-up can be started in instead of this thread's own. Only
   * populated for the orchestrator, whose project is a meta workspace with no
   * code in it — see `FollowupActionButton`.
   */
  projectChoices?: ReadonlyArray<FollowupProjectChoice> | undefined;
  className?: string | undefined;
}) {
  const [index, setIndex] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const isMobile = useIsMobile();
  // Phones get the pill by default — a card pinned over a narrow chat column
  // would cover the transcript you are trying to read before deciding. Kept
  // as "no choice yet" rather than a snapshot so the default still tracks the
  // viewport if it changes; an explicit choice wins and is remembered.
  const [storedCollapsed, setStoredCollapsed] = useState(readStoredCollapsed);
  const collapsed = storedCollapsed ?? isMobile;
  const toggleCollapsed = useCallback(() => {
    const next = !collapsed;
    writeStoredCollapsed(next);
    setStoredCollapsed(next);
  }, [collapsed]);

  // Dismissing the last card (or a card ahead of this one being resolved
  // elsewhere) must not strand the deck on an index that no longer exists.
  const clampedIndex = followups.length === 0 ? 0 : Math.min(index, followups.length - 1);
  useEffect(() => {
    if (clampedIndex !== index) {
      setIndex(clampedIndex);
    }
  }, [clampedIndex, index]);

  if (followups.length === 0) {
    return null;
  }
  const followup = followups[clampedIndex];
  if (!followup) {
    return null;
  }

  const busy = busyId === followup.id;
  const detail = followup.detail?.trim() ?? "";
  const rationale = followup.rationale?.trim() ?? "";
  const ghostCount = Math.min(followups.length - 1, 2);

  if (collapsed) {
    return (
      <div
        className={cn("pointer-events-none absolute right-3 top-3 z-30", className)}
        data-testid="followup-chip-deck"
      >
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={false}
          aria-label={`Show ${followups.length} suggested task${followups.length === 1 ? "" : "s"}`}
          className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/80 bg-card/95 px-2.5 py-1 text-xs text-muted-foreground shadow-md backdrop-blur transition-colors hover:text-foreground hover:cursor-pointer"
        >
          <LightbulbIcon className="size-3.5 text-amber-600 dark:text-amber-300/90" />
          <span className="tabular-nums">{followups.length}</span>
        </button>
      </div>
    );
  }

  return (
    <>
      <div
        className={cn(
          "pointer-events-none absolute right-3 top-3 z-30 w-[21rem] max-w-[calc(100%-1.5rem)]",
          className,
        )}
        data-testid="followup-chip-deck"
      >
        <div className="relative">
          {/* Cards behind peek out below and sit narrower on each side, which
              reads as depth without needing a real 3D transform. */}
          {Array.from({ length: ghostCount }, (_, ghost) => (
            <div
              key={ghost}
              aria-hidden
              className={cn(
                "absolute rounded-xl border border-border/60 bg-card shadow-sm",
                // Deeper cards inset further and peek a little lower.
                ghost === 0 ? "inset-x-2 -bottom-1.5 h-10" : "inset-x-4 -bottom-3 h-10",
                ghost === 0 ? "opacity-80" : "opacity-55",
              )}
            />
          ))}

          <div className="pointer-events-auto relative rounded-xl border border-border/80 bg-card p-3 shadow-lg shadow-black/20">
            <div className="flex items-start justify-between gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">Suggested task</span>
              <div className="-mr-1 -mt-0.5 flex shrink-0 items-center">
                <button
                  type="button"
                  aria-label="Open full description"
                  onClick={() => setDetailsOpen(true)}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground hover:cursor-pointer"
                >
                  <Maximize2Icon className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-expanded
                  aria-label="Hide suggested tasks"
                  onClick={toggleCollapsed}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground hover:cursor-pointer"
                >
                  <MinusIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Dismiss suggested task"
                  disabled={busy}
                  onClick={() => actions.onDismiss(followup)}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground hover:cursor-pointer disabled:opacity-40"
                >
                  <XIcon className="size-3.5" />
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setDetailsOpen(true)}
              className="mt-0.5 block w-full text-left hover:cursor-pointer"
            >
              <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
                {followup.title}
              </p>
              {detail.length > 0 ? (
                <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                  {detail}
                </p>
              ) : null}
            </button>

            <div className="mt-2.5 flex items-center justify-between gap-2">
              {followups.length > 1 ? (
                <div className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
                  <button
                    type="button"
                    aria-label="Previous suggested task"
                    disabled={clampedIndex === 0}
                    onClick={() => setIndex(clampedIndex - 1)}
                    className="rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground hover:cursor-pointer disabled:pointer-events-none disabled:opacity-30"
                  >
                    <ChevronLeftIcon className="size-3.5" />
                  </button>
                  <span className="text-[11px] tabular-nums">
                    {clampedIndex + 1} of {followups.length}
                  </span>
                  <button
                    type="button"
                    aria-label="Next suggested task"
                    disabled={clampedIndex === followups.length - 1}
                    onClick={() => setIndex(clampedIndex + 1)}
                    className="rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground hover:cursor-pointer disabled:pointer-events-none disabled:opacity-30"
                  >
                    <ChevronRightIcon className="size-3.5" />
                  </button>
                </div>
              ) : (
                <span />
              )}
              <FollowupActionButton
                followup={followup}
                busy={busy}
                canStartInWorktree={canStartInWorktree}
                projectChoices={projectChoices}
                {...actions}
              />
            </div>
          </div>
        </div>
      </div>

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogPopup className="max-w-2xl">
          {/* `pe-10` keeps a long title clear of the popup's absolute close
              button, which sits inside the header's own padding. */}
          <DialogHeader className="gap-1.5 pe-10">
            <DialogDescription className="text-xs">Suggested task</DialogDescription>
            <DialogTitle>{followup.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            {detail.length > 0 ? (
              <ChatMarkdown text={detail} cwd={cwd ?? undefined} className="text-sm" />
            ) : null}
            {rationale.length > 0 ? (
              <p className="text-sm leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">Why: </span>
                {rationale}
              </p>
            ) : null}
          </DialogPanel>
          {/* One right-aligned row at every width. The footer's default
              stacking blows these two compact controls up to full width on
              phones, which reads as two unrelated banners. */}
          <DialogFooter variant="bare" className="flex-row items-center justify-end">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDetailsOpen(false);
                actions.onDismiss(followup);
              }}
            >
              Dismiss
            </Button>
            <FollowupActionButton
              followup={followup}
              busy={busy}
              canStartInWorktree={canStartInWorktree}
              projectChoices={projectChoices}
              onStartLocally={(item) => {
                setDetailsOpen(false);
                actions.onStartLocally(item);
              }}
              onStartInWorktree={(item) => {
                setDetailsOpen(false);
                actions.onStartInWorktree(item);
              }}
              onFixInSession={(item) => {
                setDetailsOpen(false);
                actions.onFixInSession(item);
              }}
              onStartInProject={(item, projectId) => {
                setDetailsOpen(false);
                actions.onStartInProject(item, projectId);
              }}
              onStartCustom={(item) => {
                setDetailsOpen(false);
                actions.onStartCustom(item);
              }}
              onDismiss={actions.onDismiss}
            />
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
});

/**
 * Split button. "Start locally" leads because a follow-up exists precisely to
 * keep work that is out of scope out of the current conversation — spending it
 * on this thread is the exception, so it lives one click away in the menu.
 */
function FollowupActionButton({
  followup,
  busy,
  canStartInWorktree,
  projectChoices,
  onStartLocally,
  onStartInWorktree,
  onFixInSession,
  onStartInProject,
  onStartCustom,
}: FollowupDeckActions & {
  followup: FollowupState;
  busy: boolean;
  canStartInWorktree: boolean;
  projectChoices?: ReadonlyArray<FollowupProjectChoice> | undefined;
}) {
  // In the orchestrator there is no "here" to start the work in: its project is
  // a bookkeeping workspace, and spinning a follow-up off into it just opens a
  // second orchestrator conversation that is told not to touch code. So the
  // button asks which project the work belongs to instead of assuming this one.
  if (projectChoices && projectChoices.length > 0) {
    return (
      <Menu>
        <MenuTrigger render={<Button size="sm" className="h-7 px-2.5 text-xs" disabled={busy} />}>
          {busy ? "Starting…" : "Start in…"}
          <ChevronDownIcon className="ml-1 size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">
          {projectChoices.map((project) => (
            <MenuItem
              key={project.id}
              disabled={busy}
              onClick={() => onStartInProject(followup, project.id)}
            >
              {project.name}
            </MenuItem>
          ))}
          <MenuItem disabled={busy} onClick={() => onStartCustom(followup)}>
            Start custom…
          </MenuItem>
          <MenuItem disabled={busy} onClick={() => onFixInSession(followup)}>
            Answer in this conversation
          </MenuItem>
        </MenuPopup>
      </Menu>
    );
  }

  return (
    <div className="flex shrink-0 items-center">
      <Button
        size="sm"
        className="h-7 rounded-r-none px-2.5 text-xs"
        disabled={busy}
        onClick={() => onStartLocally(followup)}
      >
        {busy ? "Starting…" : "Start locally"}
      </Button>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="sm"
              className="h-7 rounded-l-none border-l border-l-white/16 px-1.5"
              aria-label="More ways to start this task"
              disabled={busy}
            />
          }
        >
          <ChevronDownIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">
          {canStartInWorktree ? (
            <MenuItem disabled={busy} onClick={() => onStartInWorktree(followup)}>
              Start in a worktree
            </MenuItem>
          ) : null}
          <MenuItem disabled={busy} onClick={() => onStartCustom(followup)}>
            Start custom…
          </MenuItem>
          <MenuItem disabled={busy} onClick={() => onFixInSession(followup)}>
            Fix in this session
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
