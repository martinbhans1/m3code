import { scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { EyeIcon, LightbulbIcon, Share2Icon } from "lucide-react";
import { useMemo } from "react";
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
import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";
import { ThreadRowLeadingStatus } from "./ThreadStatusIndicators";
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

type BoardGroupId = "needsYou" | "working" | "settled";

interface BoardRow {
  readonly thread: SidebarThreadSummary;
  readonly projectTitle: string;
  readonly access: "watch" | "control";
  readonly group: BoardGroupId;
  /** Why it is in that group, in the fewest words that still say something. */
  readonly reason: string;
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
  { id: "working", title: "Working", emptyHint: "Nothing is running." },
  { id: "settled", title: "Settled", emptyHint: "Nothing finished yet." },
];

/** Where each of the sidebar's status labels belongs on the board. */
const GROUP_BY_PILL_LABEL: Record<ThreadStatusPill["label"], BoardGroupId> = {
  "Pending Approval": "needsYou",
  "Awaiting Input": "needsYou",
  "Plan Ready": "needsYou",
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
function classifyThread(thread: SidebarThreadSummary): { group: BoardGroupId; reason: string } {
  const pill = resolveThreadStatusPill({ thread });
  if (pill !== null) {
    return { group: GROUP_BY_PILL_LABEL[pill.label], reason: pill.label };
  }

  // The pill has no colour for a failed thread, but it is the case most worth
  // surfacing.
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return { group: "needsYou", reason: "Failed" };
  }
  // Stopped mid-work and never returned to. Nothing in the UI nags about this,
  // which is exactly why it belongs at the top rather than filed under "done".
  if (thread.latestTurn?.state === "interrupted") {
    return { group: "needsYou", reason: "Interrupted, never resumed" };
  }
  if (thread.hasPendingFollowups) return { group: "settled", reason: "Has open follow-ups" };
  if (thread.latestTurn === null) return { group: "settled", reason: "Never run" };
  return { group: "settled", reason: "Finished" };
}

export function OrchestratorBoardPanel(props: {
  mode?: "sheet" | "sidebar" | "embedded";
  /**
   * The environment whose server owns the sharing settings — i.e. the one the
   * orchestrator conversation itself lives in. Threads on other connected
   * environments are governed by a different server's settings map, so listing
   * them here would report sharing that does not exist.
   */
  environmentId: EnvironmentId;
}) {
  const mode = props.mode ?? "embedded";
  const navigate = useNavigate();
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
        const { group, reason } = classifyThread(thread);
        return [
          {
            thread,
            projectTitle: projectTitleById.get(thread.projectId) ?? "Unknown project",
            access,
            group,
            reason,
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
                    {group.rows.map((row) => (
                      <button
                        key={`${row.thread.environmentId}:${row.thread.id}`}
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/60"
                        onClick={() => {
                          void navigate({
                            to: "/$environmentId/$threadId",
                            params: buildThreadRouteParams(
                              scopeThreadRef(row.thread.environmentId, row.thread.id),
                            ),
                          });
                        }}
                      >
                        <ThreadRowLeadingStatus thread={row.thread} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] text-foreground/90">
                            {row.thread.title}
                          </span>
                          <span className="block truncate text-[11px] text-muted-foreground/70">
                            {row.projectTitle} · {row.reason}
                          </span>
                        </span>
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
                      </button>
                    ))}
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
