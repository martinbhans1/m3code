import { useParams } from "@tanstack/react-router";
import { ChevronDownIcon, CompassIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  useOpenOrchestratorConversation,
  useOrchestratorProjectId,
} from "../hooks/useOrchestratorConversation";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { useNavigate } from "@tanstack/react-router";
import { readLocalApi } from "../localApi";
import { selectThreadShellsAcrossEnvironments, useStore } from "../store";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { formatRelativeTime } from "../timestampFormat";
import { SidebarGroup } from "./ui/sidebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const ROW_CLASS =
  "group/orchestrator relative flex min-w-0 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-sidebar-accent/60";

/**
 * The permanent entry point to the meta conversation, above the pins.
 *
 * It is always present, including before anything exists — the project, the
 * directory and the thread are all created on first click. That is deliberate:
 * a surface you have to assemble before you can find it is one you never use.
 */
export function SidebarOrchestratorRow() {
  const openOrchestratorConversation = useOpenOrchestratorConversation();
  const orchestratorProjectId = useOrchestratorProjectId();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadId = routeTarget?.kind === "server" ? routeTarget.threadRef.threadId : null;
  const [isOpening, setIsOpening] = useState(false);

  const navigate = useNavigate();
  const threadShells = useStore(useShallow(selectThreadShellsAcrossEnvironments));

  // Its own history: the row points at one conversation at a time, so without
  // this the earlier ones are unreachable — the project they live in is
  // deliberately hidden from the project tree.
  const orchestratorThreads = useMemo(
    () =>
      orchestratorProjectId === null
        ? []
        : threadShells
            .filter(
              (thread) => thread.projectId === orchestratorProjectId && thread.archivedAt === null,
            )
            .toSorted((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
            .slice(0, 15),
    [orchestratorProjectId, threadShells],
  );

  const isActive =
    routeThreadId !== null &&
    orchestratorProjectId !== null &&
    threadShells.some(
      (thread) => thread.id === routeThreadId && thread.projectId === orchestratorProjectId,
    );

  const open = useCallback(
    async (startFresh: boolean) => {
      if (isOpening) return;
      setIsOpening(true);
      try {
        await openOrchestratorConversation(startFresh ? { startFresh: true } : {});
      } catch (error) {
        // Opening involves creating a project and a thread, either of which can
        // be rejected by the server. Without this the click is simply inert and
        // the user has no way to tell that anything went wrong.
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not open the orchestrator",
            description: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        setIsOpening(false);
      }
    },
    [isOpening, openOrchestratorConversation],
  );

  const showHistoryMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "new", label: "New orchestrator conversation" },
          ...(orchestratorThreads.length > 0
            ? [
                { id: "history-header", label: "Recent", header: true },
                ...orchestratorThreads.map((thread) => {
                  const relative = thread.updatedAt ? formatRelativeTime(thread.updatedAt) : null;
                  const when = relative
                    ? ` — ${relative.value}${relative.suffix ? ` ${relative.suffix}` : ""}`
                    : "";
                  return { id: `thread:${thread.id}`, label: `${thread.title}${when}` };
                }),
              ]
            : []),
        ],
        position,
      );

      if (clicked === "new") {
        void open(true);
        return;
      }
      if (clicked?.startsWith("thread:")) {
        const threadId = clicked.slice("thread:".length);
        const thread = orchestratorThreads.find((candidate) => candidate.id === threadId);
        if (!thread) return;
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
        });
      }
    },
    [navigate, open, orchestratorThreads],
  );

  return (
    <SidebarGroup className="px-2 pt-2 pb-0">
      <div className="relative">
        <button
          type="button"
          aria-label="Open the orchestrator conversation"
          aria-current={isActive ? "page" : undefined}
          className={`${ROW_CLASS} pr-12 ${isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground"}`}
          onClick={() => void open(false)}
        >
          <CompassIcon className="size-4 shrink-0" />
          <span className="truncate font-medium">Orchestrator</span>
        </button>
        {/* Starting a fresh conversation is its own button rather than a menu
            entry: the row always resumes the most recent one, so without a
            visible "+" there is no obvious way to begin a new one at all. */}
        <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="New orchestrator conversation"
                  className="flex size-5 items-center justify-center rounded text-muted-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  onClick={(event) => {
                    event.stopPropagation();
                    void open(true);
                  }}
                >
                  <PlusIcon className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup>New conversation</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Orchestrator conversations"
                  className="flex size-5 items-center justify-center rounded text-muted-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  onClick={(event) => {
                    event.stopPropagation();
                    void showHistoryMenu({ x: event.clientX, y: event.clientY });
                  }}
                >
                  <ChevronDownIcon className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup>Conversations</TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </SidebarGroup>
  );
}
