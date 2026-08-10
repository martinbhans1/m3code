import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime";
import { useShallow } from "zustand/react/shallow";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { ScrollArea } from "./ui/scroll-area";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { sortThreads } from "../lib/threadSort";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";

/** Upper bound on rows rendered in the narrow-width recent list. */
const RECENT_THREAD_LIMIT = 25;

/**
 * Below the `md` breakpoint the sidebar collapses to an off-canvas sheet, so a
 * bare "pick a thread" message is a dead end — there is nothing on screen to
 * pick from. This renders the thread list inline instead. Wide windows keep the
 * plain empty state, because there the docked sidebar already shows this list
 * and duplicating it side by side would be redundant.
 */
function RecentThreadsPanel({ fallback }: { fallback: React.ReactNode }) {
  const navigate = useNavigate();
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));

  const projectNameByKey = useMemo(() => {
    const mapping = new Map<string, string>();
    for (const project of projects) {
      mapping.set(`${project.environmentId}:${project.id}`, project.name);
    }
    return mapping;
  }, [projects]);

  const recentThreads = useMemo(() => {
    const active = threads.filter((thread) => thread.archivedAt === null);
    // Pinned threads float to the top, mirroring the sidebar's ordering; the
    // rest fall back to most-recent-activity.
    const pinned = sortThreads(
      active.filter((thread) => thread.pinnedAt !== null),
      "updated_at",
    );
    const rest = sortThreads(
      active.filter((thread) => thread.pinnedAt === null),
      "updated_at",
    );
    return [...pinned, ...rest].slice(0, RECENT_THREAD_LIMIT);
  }, [threads]);

  // A brand-new install has nothing to list; fall back to the plain message so
  // the narrow view is never blank.
  if (recentThreads.length === 0) {
    return <>{fallback}</>;
  }

  return (
    <ScrollArea axis="vertical" className="min-h-0 flex-1">
      <ul className="flex flex-col gap-0.5 px-2 py-2">
        {recentThreads.map((thread) => {
          const threadRef = scopeThreadRef(thread.environmentId, thread.id);
          const projectName = projectNameByKey.get(`${thread.environmentId}:${thread.projectId}`);
          return (
            <li key={scopedThreadKey(threadRef)}>
              <button
                type="button"
                className="flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-hidden ring-ring transition-colors hover:bg-accent focus-visible:ring-2 active:bg-accent"
                onClick={() => {
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(threadRef),
                  });
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm text-foreground">{thread.title}</span>
                  {projectName ? (
                    <span className="truncate text-xs text-muted-foreground/60">{projectName}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
                  {formatRelativeTimeLabel(
                    thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </ScrollArea>
  );
}

export function NoActiveThreadState({
  headerLabel = "No active thread",
  title = "Pick a thread to continue",
  description = "Select an existing thread or create a new one to get started.",
  showRecentThreads = false,
}: {
  headerLabel?: string;
  title?: string;
  description?: string;
  /**
   * Show the inline thread list on narrow viewports. Only meaningful for a
   * genuine "nothing selected" state — loading and error states pass their own
   * copy and should stay a plain message.
   */
  showRecentThreads?: boolean;
} = {}) {
  const emptyState = (
    <Empty className="flex-1">
      <div className="w-full max-w-lg px-8 py-12">
        <EmptyHeader className="max-w-none">
          <EmptyTitle className="text-foreground text-xl">{title}</EmptyTitle>
          {description ? (
            <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
              {description}
            </EmptyDescription>
          ) : null}
        </EmptyHeader>
      </div>
    </Empty>
  );

  return (
    <SidebarInset className="app-chat-surface h-dvh min-h-0 overflow-hidden overscroll-y-none bg-transparent text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
        <header
          className={cn(
            "px-3 sm:px-5",
            isElectron ? "workspace-topbar drag-region" : "workspace-topbar",
          )}
        >
          {/* The sidebar collapses to an off-canvas sheet below `md`, so the
              trigger is the ONLY way back to the thread list. It must be gated
              on viewport width, not platform — gating it on `isElectron` left
              narrow desktop windows with no way to open the sidebar at all. */}
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <span
              className={cn(
                "wco:pr-[var(--workspace-native-controls-inset)]",
                isElectron
                  ? "text-sm font-medium text-foreground md:text-xs md:font-normal md:text-muted-foreground/50"
                  : "text-sm font-medium text-foreground md:text-muted-foreground/60",
              )}
            >
              {headerLabel}
            </span>
          </div>
        </header>

        <div className="app-chat-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {showRecentThreads ? (
            <>
              <div className="flex min-h-0 flex-1 flex-col md:hidden">
                <RecentThreadsPanel fallback={emptyState} />
              </div>
              {/* Wide windows keep the plain empty state next to the docked sidebar. */}
              <div className="hidden min-h-0 flex-1 md:flex md:flex-col">{emptyState}</div>
            </>
          ) : (
            emptyState
          )}
        </div>
      </div>
    </SidebarInset>
  );
}
