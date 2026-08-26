import { scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { EllipsisIcon, EyeIcon, LightbulbIcon, Share2Icon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useSettings } from "../hooks/useSettings";
import { resolveOrchestratorAccess } from "../lib/orchestratorAccess";
import { cn } from "../lib/utils";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import type { SidebarThreadSummary } from "../types";
import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "../timestampFormat";
import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";
import { ThreadRowLeadingStatus } from "./ThreadStatusIndicators";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * The orchestrator's status board: every conversation it can currently see,
 * grouped by what each one needs from you.
 *
 * The grouping is the point. "Four conversations idle" is not actionable;
 * "one wants an approval, one asked a question, two are done" is. Threads sort
 * by how much they are blocking you, not by when they last moved — the thing
 * that has been stuck longest is the thing most likely to have been forgotten.
 */

type BoardGroupId = "needsYou" | "stalled" | "working" | "settled";

interface BoardRow {
  readonly thread: SidebarThreadSummary;
  readonly projectTitle: string;
  readonly access: "watch" | "control";
  readonly group: BoardGroupId;
  /**
   * Why it is in that group — but only when the status dot beside it does not
   * already say so. Repeating "Working" next to a dot labelled "Working" costs
   * the one line that could have said when.
   */
  readonly detail: string | null;
  /** When something last happened, phrased for the group it landed in. */
  readonly timing: string | null;
}

const GROUP_ORDER: ReadonlyArray<{
  readonly id: BoardGroupId;
  readonly title: string;
  readonly emptyHint: string;
}> = [
  {
    id: "needsYou",
    title: "Needs you",
    emptyHint: "Nothing is blocked on you.",
  },
  { id: "stalled", title: "Stalled", emptyHint: "Nothing has stalled." },
  { id: "working", title: "Working", emptyHint: "Nothing is running." },
  { id: "settled", title: "Settled", emptyHint: "Nothing finished yet." },
];

/** Where each of the sidebar's status labels belongs on the board. */
const GROUP_BY_PILL_LABEL: Record<ThreadStatusPill["label"], BoardGroupId> = {
  "Pending Approval": "needsYou",
  "Awaiting Input": "needsYou",
  "Plan Ready": "needsYou",
  Stalled: "stalled",
  Working: "working",
  Connecting: "working",
  Completed: "settled",
};

/**
 * Delegates to `resolveThreadStatusPill` — the same derivation the sidebar rows
 * use — rather than restating its precedence.
 *
 * An earlier version of this duplicated the ladder and drifted immediately: it
 * grew branches for a running *turn* and for errors that the pill has no
 * equivalent of, so a thread with a stale running turn row and a dead session
 * read as "Working" here and as nothing at all in the sidebar. Two views
 * disagreeing about the same conversation is worse than either being sparse.
 *
 * What is added on top is only what the pill returns `null` for and a board
 * must not silently drop.
 */
function classifyThread(thread: SidebarThreadSummary): {
  group: BoardGroupId;
  detail: string | null;
} {
  const pill = resolveThreadStatusPill({ thread });
  // No detail: the dot beside the title is already labelled with exactly this.
  if (pill !== null) return { group: GROUP_BY_PILL_LABEL[pill.label], detail: null };

  // The pill has no colour for a failed thread, but it is the case most worth
  // surfacing.
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return { group: "needsYou", detail: "Failed" };
  }
  // Stopped mid-work and never returned to. Nothing in the UI nags about this,
  // which is exactly why it belongs at the top rather than filed under "done".
  if (thread.latestTurn?.state === "interrupted") {
    return { group: "needsYou", detail: "Interrupted, never resumed" };
  }
  if (thread.hasPendingFollowups) return { group: "settled", detail: "Open follow-ups" };
  if (thread.latestTurn === null) return { group: "settled", detail: "Never run" };
  return { group: "settled", detail: null };
}

/**
 * When something last happened, phrased for what the group means.
 *
 * "Awaiting Input" without a time is only half an answer — a question asked two
 * minutes ago and one asked on Tuesday need very different things from you, and
 * the board exists precisely to tell those apart at a glance.
 */
function timingFor(thread: SidebarThreadSummary, group: BoardGroupId): string | null {
  const startedAt = thread.latestTurn?.startedAt ?? null;
  const completedAt = thread.latestTurn?.completedAt ?? null;
  const lastMoved = thread.session?.updatedAt ?? thread.updatedAt ?? null;

  switch (group) {
    case "working":
      return startedAt === null ? null : `running ${formatElapsedDurationLabel(startedAt)}`;
    case "stalled":
      return lastMoved === null ? null : `silent for ${formatElapsedDurationLabel(lastMoved)}`;
    case "needsYou":
      return lastMoved === null ? null : `waiting ${formatElapsedDurationLabel(lastMoved)}`;
    case "settled": {
      const settledAt = completedAt ?? thread.updatedAt ?? null;
      return settledAt === null ? null : formatRelativeTimeLabel(settledAt);
    }
  }
}

/**
 * The message the board puts in the composer for a row, or null when there is
 * nothing obvious to say about it.
 *
 * These are the sentences you would have typed anyway. Writing them for you is
 * the difference between the board being somewhere you look and somewhere you
 * work from — and each one is a request, not an action, so the orchestrator
 * still confirms anything it would change.
 */
function primaryActionFor(
  row: BoardRow,
): { readonly label: string; readonly prompt: string } | null {
  const name = `"${row.thread.title}"`;
  if (row.thread.hasPendingApprovals) {
    return {
      label: "Ask what it wants to run",
      prompt: `What is ${name} waiting for approval to do? Show me the command or edit, then tell me whether to allow it.`,
    };
  }
  if (row.thread.hasPendingUserInput) {
    return {
      label: "Show me the question",
      prompt: `Show me the question ${name} is asking, with its options, so I can answer it from here.`,
    };
  }
  if (row.group === "stalled") {
    return {
      label: "Clear the dead turn",
      prompt: `The turn in ${name} has been marked running but silent for a long time. Check what it actually got done, then stop the turn so the conversation is usable again.`,
    };
  }
  if (row.group === "working") {
    return {
      label: "Catch me up",
      prompt: `What is ${name} doing right now, and how far along is it?`,
    };
  }
  return {
    label: "What did it change?",
    prompt: `What did ${name} actually change on disk? Check the files rather than what it said it did.`,
  };
}

export function OrchestratorBoardPanel(props: {
  mode?: "sheet" | "sidebar" | "embedded";
  /**
   * Puts a message in the orchestrator's composer rather than sending it. The
   * board proposes the sentence; pressing enter stays your decision.
   */
  onComposeMessage?: (prompt: string) => void;
  /**
   * The environment whose server owns the sharing settings — i.e. the one the
   * orchestrator conversation itself lives in. Threads on other connected
   * environments are governed by a different server's settings map, so listing
   * them here would report sharing that does not exist.
   */
  environmentId: EnvironmentId;
}) {
  const mode = props.mode ?? "embedded";
  const { onComposeMessage } = props;
  const navigate = useNavigate();
  const openThread = useCallback(
    (thread: SidebarThreadSummary) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
    [navigate],
  );
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const orchestratorProjectId = useSettings((settings) => settings.orchestratorProjectId);
  const defaultAccess = useSettings((settings) => settings.defaultOrchestratorThreadAccess);
  const accessMap = useSettings((settings) => settings.orchestratorThreadAccess);
  const accessOverride = useSettings((settings) => settings.orchestratorAccessOverride);

  const rows = useMemo<ReadonlyArray<BoardRow>>(() => {
    const projectTitleById = new Map(projects.map((project) => [project.id, project.name]));
    return threads
      .flatMap((thread) => {
        if (thread.environmentId !== props.environmentId) return [];
        // The orchestrator's own conversations are never on its board — it does
        // not supervise itself.
        if (thread.projectId === orchestratorProjectId) return [];
        if (thread.archivedAt !== null) return [];
        const access = resolveOrchestratorAccess({
          override: accessMap[thread.id],
          defaultAccess,
          accessOverride,
        });
        if (access === "none") return [];
        const { group, detail } = classifyThread(thread);
        return [
          {
            thread,
            projectTitle: projectTitleById.get(thread.projectId) ?? "Unknown project",
            access,
            group,
            detail,
            timing: timingFor(thread, group),
          } satisfies BoardRow,
        ];
      })
      .toSorted((left, right) =>
        (right.thread.updatedAt ?? "").localeCompare(left.thread.updatedAt ?? ""),
      );
  }, [
    accessMap,
    accessOverride,
    defaultAccess,
    orchestratorProjectId,
    projects,
    props.environmentId,
    threads,
  ]);

  const grouped = useMemo(
    () =>
      GROUP_ORDER.map((group) => ({
        ...group,
        rows: rows.filter((row) => row.group === group.id),
      })),
    [rows],
  );

  const needsYouCount = grouped[0]?.rows.length ?? 0;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-card/50",
        mode === "sidebar"
          ? "h-full w-[340px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <span className="font-medium text-sm">Board</span>
        <span className="text-[11px] text-muted-foreground/70 tabular-nums">
          {rows.length === 0
            ? "nothing in view"
            : `${rows.length} in view${needsYouCount > 0 ? ` · ${needsYouCount} need you` : ""}`}
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {rows.length === 0 ? (
          <p className="p-4 text-[13px] text-muted-foreground/80 leading-relaxed">
            The orchestrator cannot see any conversations yet. Open everything at once from the
            access control in this conversation&rsquo;s composer, or share them one at a time from
            the control next to each conversation&rsquo;s model picker.
          </p>
        ) : (
          <div className="space-y-4 p-3">
            {grouped.map((group) =>
              group.rows.length === 0 ? null : (
                <section key={group.id}>
                  <h3 className="mb-1.5 px-1 font-medium text-[11px] text-muted-foreground/70 uppercase tracking-wide">
                    {group.title}
                    <span className="ml-1.5 tabular-nums">{group.rows.length}</span>
                  </h3>
                  <div className="space-y-1">
                    {group.rows.map((row) => {
                      const action = primaryActionFor(row);
                      const subtitle = [row.projectTitle, row.detail, row.timing]
                        .filter((part) => part !== null && part !== "")
                        .join(" · ");
                      return (
                        <div
                          key={`${row.thread.environmentId}:${row.thread.id}`}
                          className="group/board-row flex w-full items-center gap-1 rounded-md pr-1 hover:bg-muted/60"
                        >
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left"
                            onClick={() => {
                              openThread(row.thread);
                            }}
                          >
                            <ThreadRowLeadingStatus thread={row.thread} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] text-foreground/90">
                                {row.thread.title}
                              </span>
                              <span className="block truncate text-[11px] text-muted-foreground/70">
                                {subtitle}
                              </span>
                            </span>
                          </button>
                          {row.thread.hasPendingFollowups ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <LightbulbIcon className="size-3.5 shrink-0 text-amber-500" />
                                }
                              />
                              <TooltipPopup side="left">Open follow-ups</TooltipPopup>
                            </Tooltip>
                          ) : null}
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                row.access === "control" ? (
                                  <Share2Icon className="size-3.5 shrink-0 text-muted-foreground/60" />
                                ) : (
                                  <EyeIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
                                )
                              }
                            />
                            <TooltipPopup side="left">
                              {row.access === "control"
                                ? "The orchestrator can read this and send to it"
                                : "The orchestrator can read this, but not send to it"}
                            </TooltipPopup>
                          </Tooltip>
                          <Menu>
                            <MenuTrigger
                              aria-label={`Actions for ${row.thread.title}`}
                              className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 opacity-0 outline-hidden ring-ring hover:bg-muted focus-visible:opacity-100 focus-visible:ring-1 group-hover/board-row:opacity-100 data-[popup-open]:opacity-100"
                            >
                              <EllipsisIcon className="size-3.5" />
                            </MenuTrigger>
                            <MenuPopup align="end" className="w-60" side="bottom">
                              {onComposeMessage && action ? (
                                <MenuItem
                                  onClick={() => {
                                    onComposeMessage(action.prompt);
                                  }}
                                >
                                  {action.label}
                                </MenuItem>
                              ) : null}
                              {onComposeMessage && row.thread.hasPendingFollowups ? (
                                <MenuItem
                                  onClick={() => {
                                    onComposeMessage(
                                      `What follow-ups are still open on "${row.thread.title}", and is any of them already being handled somewhere else?`,
                                    );
                                  }}
                                >
                                  Show its follow-ups
                                </MenuItem>
                              ) : null}
                              {onComposeMessage ? <MenuSeparator /> : null}
                              <MenuItem
                                onClick={() => {
                                  openThread(row.thread);
                                }}
                              >
                                Open the conversation
                              </MenuItem>
                            </MenuPopup>
                          </Menu>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ),
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
