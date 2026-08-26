import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ChevronDownIcon, CompassIcon, LightbulbIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  useOpenOrchestratorConversation,
  useOrchestratorProjectId,
} from "../hooks/useOrchestratorConversation";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../store";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { useUiStateStore } from "../uiStateStore";
import { resolveProjectStatusIndicator, resolveThreadStatusPill } from "./Sidebar.logic";
import { ThreadStatusLabel } from "./ThreadStatusIndicators";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "./ui/sidebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const ACTION_BUTTON_CLASS =
  "relative inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 outline-hidden ring-ring after:absolute after:-inset-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-50 md:after:hidden";

/**
 * The permanent entry point to the meta conversation, above the pins.
 *
 * It is always present, including before anything exists — the project, the
 * directory and the thread are all created on first click. That is deliberate:
 * a surface you have to assemble before you can find it is one you never use.
 *
 * Opening it follows the same mobile path as every other sidebar thread: close
 * the sheet, then navigate. The "+" and conversation menu sit beside the row
 * rather than on top of it so a tap actually hits the control.
 */
export function SidebarOrchestratorRow() {
  const openOrchestratorConversation = useOpenOrchestratorConversation();
  const orchestratorProjectId = useOrchestratorProjectId();
  const { isMobile, setOpenMobile } = useSidebar();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadId = routeTarget?.kind === "server" ? routeTarget.threadRef.threadId : null;
  const [isOpening, setIsOpening] = useState(false);

  const navigate = useNavigate();
  const sidebarThreads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));

  // Its own history: the row points at one conversation at a time, so without
  // this the earlier ones are unreachable — the project they live in is
  // deliberately hidden from the project tree.
  const orchestratorThreads = useMemo(
    () =>
      orchestratorProjectId === null
        ? []
        : sidebarThreads
            .filter(
              (thread) => thread.projectId === orchestratorProjectId && thread.archivedAt === null,
            )
            .toSorted((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
            .slice(0, 15),
    [orchestratorProjectId, sidebarThreads],
  );

  // The row stands in for a project the tree never shows, so it has to carry
  // the same signals a thread row does: whether the orchestrator is working,
  // waiting on you, or has finished something you have not read yet.
  const threadLastVisitedAts = useUiStateStore(
    useShallow((state) =>
      orchestratorThreads.map(
        (thread) =>
          state.threadLastVisitedAtById[
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
          ] ?? null,
      ),
    ),
  );

  const { rowStatus, statusByThreadId, hasPendingFollowups } = useMemo(() => {
    const statusByThreadId = new Map(
      orchestratorThreads.map((thread, index) => {
        const lastVisitedAt = threadLastVisitedAts[index];
        return [
          thread.id,
          resolveThreadStatusPill({
            thread: {
              ...thread,
              ...(lastVisitedAt !== null && lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
            },
          }),
        ] as const;
      }),
    );
    return {
      statusByThreadId,
      rowStatus: resolveProjectStatusIndicator([...statusByThreadId.values()]),
      hasPendingFollowups: orchestratorThreads.some((thread) => thread.hasPendingFollowups),
    };
  }, [orchestratorThreads, threadLastVisitedAts]);

  const isActive =
    routeThreadId !== null &&
    orchestratorProjectId !== null &&
    sidebarThreads.some(
      (thread) => thread.id === routeThreadId && thread.projectId === orchestratorProjectId,
    );

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);

  const open = useCallback(
    (startFresh: boolean) => {
      if (isOpening) return;
      // Same order as a regular thread tap: close the mobile sheet first so the
      // chat is visible, then navigate. Opening is async (create project /
      // draft), so waiting for it would leave the sheet covering the result.
      closeMobileSidebar();
      setIsOpening(true);
      void openOrchestratorConversation(startFresh ? { startFresh: true } : {})
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not open the orchestrator",
              description: error instanceof Error ? error.message : String(error),
            }),
          );
        })
        .finally(() => {
          setIsOpening(false);
        });
    },
    [closeMobileSidebar, isOpening, openOrchestratorConversation],
  );

  const openExistingThread = useCallback(
    (thread: SidebarThreadSummary) => {
      closeMobileSidebar();
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
    [closeMobileSidebar, navigate],
  );

  return (
    <SidebarGroup className="px-2 pt-2 pb-0">
      <SidebarMenu>
        <SidebarMenuItem className="flex items-center gap-0.5">
          <SidebarMenuButton
            aria-current={isActive ? "page" : undefined}
            aria-label="Open the orchestrator conversation"
            className="min-w-0 flex-1 text-muted-foreground"
            disabled={isOpening}
            isActive={isActive}
            onClick={() => open(false)}
          >
            <CompassIcon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-medium">Orchestrator</span>
            {hasPendingFollowups ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      aria-label="Suggested task waiting"
                      className="inline-flex shrink-0 items-center justify-center text-amber-600 dark:text-amber-300/90"
                    >
                      <LightbulbIcon className="size-3" />
                    </span>
                  }
                />
                <TooltipPopup side="top">Suggested task waiting</TooltipPopup>
              </Tooltip>
            ) : null}
            {rowStatus ? <ThreadStatusLabel status={rowStatus} compact /> : null}
          </SidebarMenuButton>
          {isMobile ? (
            <button
              type="button"
              aria-label="New orchestrator conversation"
              className={ACTION_BUTTON_CLASS}
              disabled={isOpening}
              onClick={() => open(true)}
            >
              <PlusIcon className="size-3.5" />
            </button>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="New orchestrator conversation"
                    className={ACTION_BUTTON_CLASS}
                    disabled={isOpening}
                    onClick={() => open(true)}
                  />
                }
              >
                <PlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>New conversation</TooltipPopup>
            </Tooltip>
          )}
          <Menu>
            {isMobile ? (
              <MenuTrigger
                aria-label="Orchestrator conversations"
                className={ACTION_BUTTON_CLASS}
                disabled={isOpening}
              >
                <ChevronDownIcon className="size-3.5" />
              </MenuTrigger>
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <MenuTrigger
                      aria-label="Orchestrator conversations"
                      className={ACTION_BUTTON_CLASS}
                      disabled={isOpening}
                    />
                  }
                >
                  <ChevronDownIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>Conversations</TooltipPopup>
              </Tooltip>
            )}
            <MenuPopup align="end" className="w-64" side="bottom">
              <MenuItem
                disabled={isOpening}
                onClick={() => {
                  open(true);
                }}
              >
                <PlusIcon />
                New conversation
              </MenuItem>
              {orchestratorThreads.length > 0 ? (
                <>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>Recent</MenuGroupLabel>
                    {orchestratorThreads.map((thread) => {
                      const threadStatus = statusByThreadId.get(thread.id) ?? null;
                      return (
                        <MenuItem
                          key={thread.id}
                          className="justify-between gap-3"
                          onClick={() => {
                            openExistingThread(thread);
                          }}
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-1.5">
                            {threadStatus ? (
                              <ThreadStatusLabel status={threadStatus} compact />
                            ) : null}
                            <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                          </span>
                          {thread.updatedAt ? (
                            <span className="shrink-0 text-muted-foreground text-xs">
                              {formatRelativeTimeLabel(thread.updatedAt)}
                            </span>
                          ) : null}
                        </MenuItem>
                      );
                    })}
                  </MenuGroup>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}
