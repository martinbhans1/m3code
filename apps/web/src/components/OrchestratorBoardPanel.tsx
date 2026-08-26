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
import {
  classifyThread,
  GROUP_ORDER,
  primaryActionFor,
  timingFor,
  type BoardRow,
} from "./OrchestratorBoardPanel.logic";
import { ThreadRowLeadingStatus } from "./ThreadStatusIndicators";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

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
