import type {
  EnvironmentScopedProjectShell,
  EnvironmentScopedThreadShell,
  ScopedThreadSearchResult,
  VcsStatusState,
} from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { threadMatchesListFilter } from "@t3tools/shared/threadTags";
import { SymbolView } from "expo-symbols";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useThemeColor } from "../../lib/useThemeColor";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import type { SavedRemoteConnection } from "../../lib/connection";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { relativeTime } from "../../lib/time";
import type { RemoteCatalogState } from "../../state/use-remote-catalog";
import { useThreadMessageSearch } from "../../state/use-thread-message-search";
import { useVcsStatus } from "../../state/use-vcs-status";
import { threadStatusTone } from "../threads/threadPresentation";

/* ─── Types ──────────────────────────────────────────────────────────── */

interface HomeScreenProps {
  readonly projects: ReadonlyArray<EnvironmentScopedProjectShell>;
  readonly threads: ReadonlyArray<EnvironmentScopedThreadShell>;
  readonly catalogState: RemoteCatalogState;
  readonly savedConnectionsById: Readonly<Record<string, SavedRemoteConnection>>;
  readonly searchQuery: string;
  /** Hide completed conversations (ignored while searching, so old work stays findable). */
  readonly hideCompleted: boolean;
  /** Scoped project key -> tags the list is narrowed to. */
  readonly selectedTagsByProject: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Scoped keys of each environment's orchestrator project. */
  readonly orchestratorProjectKeys: ReadonlySet<string>;
  readonly onAddConnection: () => void;
  readonly onSelectThread: (thread: EnvironmentScopedThreadShell) => void;
  readonly onSelectSearchResult: (result: ScopedThreadSearchResult) => void;
}

type ProjectGroupKind = "orchestrator" | "pinned" | "project";

interface ProjectGroup {
  readonly key: string;
  readonly kind: ProjectGroupKind;
  readonly project: EnvironmentScopedProjectShell;
  readonly threads: ReadonlyArray<EnvironmentScopedThreadShell>;
}

function pinnedTime(thread: EnvironmentScopedThreadShell): number {
  return thread.pinnedAt ? new Date(thread.pinnedAt).getTime() : 0;
}

const projectGroupActivityOrder = Order.mapInput(
  Order.Struct({
    activityAt: Order.flip(Order.Number),
  }),
  (group: ProjectGroup) => ({
    activityAt: new Date(group.threads[0]!.updatedAt ?? group.threads[0]!.createdAt).getTime(),
  }),
);

/* ─── Status indicator colors ────────────────────────────────────────── */

function statusColors(thread: EnvironmentScopedThreadShell): { bg: string; fg: string } {
  switch (thread.session?.status) {
    case "running":
      return { bg: "rgba(249,115,22,0.14)", fg: "#f97316" };
    case "ready":
      return { bg: "rgba(34,197,94,0.14)", fg: "#22c55e" };
    case "starting":
      return { bg: "rgba(59,130,246,0.14)", fg: "#3b82f6" };
    case "error":
      return { bg: "rgba(239,68,68,0.14)", fg: "#ef4444" };
    default:
      return { bg: "rgba(163,163,163,0.10)", fg: "#a3a3a3" };
  }
}

const COLLAPSED_THREAD_LIMIT = 6;
// The orchestrator is read for its latest conversation; older ones stay one tap away.
const ORCHESTRATOR_COLLAPSED_LIMIT = 1;

function collapsedLimit(kind: ProjectGroupKind): number {
  return kind === "orchestrator" ? ORCHESTRATOR_COLLAPSED_LIMIT : COLLAPSED_THREAD_LIMIT;
}

function deriveEmptyState(props: {
  readonly catalogState: RemoteCatalogState;
  readonly projectCount: number;
}): { readonly title: string; readonly detail: string; readonly loading: boolean } {
  const { catalogState } = props;
  if (catalogState.isLoadingSavedConnections) {
    return {
      title: "Loading environments",
      detail: "Checking saved environments on this device.",
      loading: true,
    };
  }

  if (!catalogState.hasSavedConnections) {
    return {
      title: "No environments connected",
      detail: "Add an environment to load projects and start coding sessions.",
      loading: false,
    };
  }

  if (catalogState.connectionState === "disconnected" && !catalogState.hasLoadedShellSnapshot) {
    return {
      title: "Environment unavailable",
      detail:
        catalogState.connectionError ??
        "The saved environment is offline. Check the URL or start the environment, then retry.",
      loading: false,
    };
  }

  if (
    catalogState.hasConnectingEnvironment &&
    !catalogState.hasLoadedShellSnapshot &&
    catalogState.connectionError === null
  ) {
    return {
      title: "Connecting to environment",
      detail: "Loading projects and threads from the saved environment.",
      loading: true,
    };
  }

  if (props.projectCount === 0 && catalogState.hasLoadedShellSnapshot) {
    return {
      title: "No projects found",
      detail: "The connected environment did not report any projects.",
      loading: false,
    };
  }

  return {
    title: "No threads yet",
    detail: "Create a task to start a new coding session in one of your connected projects.",
    loading: false,
  };
}

/* ─── Project group header ───────────────────────────────────────────── */

function ProjectGroupLabel(props: {
  readonly project: EnvironmentScopedProjectShell;
  readonly kind: ProjectGroupKind;
  readonly totalThreadCount: number;
  readonly httpBaseUrl: string | null;
  readonly bearerToken: string | null;
  readonly isExpanded: boolean;
  readonly onToggleExpand: () => void;
}) {
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const hiddenCount = props.totalThreadCount - collapsedLimit(props.kind);

  return (
    <View className="flex-row items-center gap-2.5 px-1 pb-2">
      <ProjectFavicon
        size={18}
        projectTitle={props.project.title}
        httpBaseUrl={props.httpBaseUrl}
        workspaceRoot={props.project.workspaceRoot}
        bearerToken={props.bearerToken}
      />
      <Text
        className="flex-1 text-[12px] font-t3-medium uppercase text-foreground-muted"
        style={{ letterSpacing: 0.5 }}
        numberOfLines={1}
      >
        {props.project.title}
      </Text>

      {props.kind === "pinned" ? (
        <SymbolView name="pin.fill" size={11} tintColor={iconSubtleColor} type="monochrome" />
      ) : null}

      {hiddenCount > 0 ? (
        <Pressable onPress={props.onToggleExpand} hitSlop={8}>
          <Text
            className="text-[12px] font-t3-medium text-foreground-muted"
            style={{ letterSpacing: 0.4 }}
          >
            {props.isExpanded ? "Show less" : `${hiddenCount} more`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/* ─── Git summary line ──────────────────────────────────────────────── */

function gitSummaryParts(gitStatus: VcsStatusState): ReadonlyArray<string> {
  if (!gitStatus.data) return [];
  const { data } = gitStatus;
  const parts: string[] = [];
  if (data.hasWorkingTreeChanges) {
    parts.push(`${data.workingTree.files.length} changed`);
  }
  if (data.aheadCount > 0) parts.push(`${data.aheadCount} ahead`);
  if (data.behindCount > 0) parts.push(`${data.behindCount} behind`);
  if (data.pr?.state === "open") parts.push(`PR #${data.pr.number}`);
  return parts;
}

/* ─── Thread row ─────────────────────────────────────────────────────── */

function ThreadRow(props: {
  readonly thread: EnvironmentScopedThreadShell;
  readonly projectCwd: string | null;
  readonly onPress: () => void;
  readonly isLast: boolean;
}) {
  const separatorColor = useThemeColor("--color-separator");
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const { bg, fg } = statusColors(props.thread);
  const tone = threadStatusTone(props.thread);
  const timestamp = relativeTime(props.thread.updatedAt ?? props.thread.createdAt);
  const branch = props.thread.branch;

  // Subscribe to live git status — only when thread has a branch set.
  // Threads sharing the same cwd share one WS subscription via ref-counting.
  const cwd = branch ? (props.thread.worktreePath ?? props.projectCwd) : null;
  const gitStatus = useVcsStatus({
    environmentId: cwd ? props.thread.environmentId : null,
    cwd,
  });
  const gitParts = gitSummaryParts(gitStatus);

  return (
    <Pressable onPress={props.onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      <View
        style={{
          flexDirection: "row",
          paddingLeft: 16,
          paddingRight: 16,
          paddingVertical: 10,
          gap: 12,
          borderBottomWidth: props.isLast ? 0 : 1,
          borderBottomColor: separatorColor,
        }}
      >
        {/* Git status indicator */}
        <View
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            backgroundColor: bg,
            alignItems: "center",
            justifyContent: "center",
            marginTop: 2,
          }}
        >
          <SymbolView name="arrow.triangle.branch" size={13} tintColor={fg} type="monochrome" />
        </View>

        {/* Content */}
        <View style={{ flex: 1, gap: 3 }}>
          {/* Title + Status + Timestamp */}
          <View className="flex-row items-center justify-between gap-2">
            <Text
              className="flex-1 text-[15px] font-t3-bold leading-[20px] text-foreground"
              numberOfLines={1}
            >
              {props.thread.title}
            </Text>
            <View className="flex-row items-center gap-2">
              <View
                className={tone.pillClassName}
                style={{ borderRadius: 99, paddingHorizontal: 6, paddingVertical: 2 }}
              >
                <Text className={`text-[10px] font-t3-bold ${tone.textClassName}`}>
                  {tone.label}
                </Text>
              </View>
              <Text
                className="text-[12px] text-foreground-tertiary"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {timestamp}
              </Text>
            </View>
          </View>

          {/* Branch + git info */}
          {branch ? (
            <View className="flex-row items-center gap-1.5" style={{ marginTop: 1 }}>
              <SymbolView
                name="arrow.triangle.branch"
                size={10}
                tintColor={iconSubtleColor}
                type="monochrome"
              />
              <Text
                className="text-[11px] text-foreground-tertiary"
                numberOfLines={1}
                style={{ fontFamily: "monospace" }}
              >
                {branch}
              </Text>
              {gitParts.length > 0 ? (
                <Text className="text-[11px] text-foreground-tertiary">
                  {" · " + gitParts.join(" · ")}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

/* ─── Message search hit ─────────────────────────────────────────────── */

function MessageHitRow(props: {
  readonly result: ScopedThreadSearchResult;
  readonly onPress: () => void;
  readonly isLast: boolean;
}) {
  const separatorColor = useThemeColor("--color-separator");
  const { result } = props;
  const context = [result.projectTitle, ...(result.archivedAt ? ["Archived"] : [])].join(" · ");
  const snippet = result.snippet
    ? `${result.matchedRole === "user" ? "You: " : ""}${result.snippet}`
    : null;

  return (
    <Pressable onPress={props.onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 10,
          gap: 3,
          borderBottomWidth: props.isLast ? 0 : 1,
          borderBottomColor: separatorColor,
        }}
      >
        <View className="flex-row items-center justify-between gap-2">
          <Text
            className="flex-1 text-[15px] font-t3-bold leading-[20px] text-foreground"
            numberOfLines={1}
          >
            {result.title}
          </Text>
          <Text
            className="text-[12px] text-foreground-tertiary"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {relativeTime(result.updatedAt)}
          </Text>
        </View>
        <Text className="text-[11px] text-foreground-tertiary" numberOfLines={1}>
          {context}
        </Text>
        {snippet ? (
          <Text className="text-[13px] leading-[18px] text-foreground-muted" numberOfLines={3}>
            {snippet}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function threadKey(environmentId: EnvironmentId, threadId: string): string {
  return `${environmentId}:${threadId}`;
}

/* ─── Main screen ────────────────────────────────────────────────────── */

export function HomeScreen(props: HomeScreenProps) {
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const accentColor = useThemeColor("--color-icon-muted");

  const toggleExpanded = useCallback((key: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /* Build project title lookup for search */
  const projectTitleByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of props.projects) {
      map.set(scopedProjectKey(p.environmentId, p.id), p.title);
    }
    return map;
  }, [props.projects]);

  /* Filter threads by search query */
  const filteredThreads = useMemo(() => {
    const q = props.searchQuery.trim().toLowerCase();
    const listed = props.threads.filter((thread) =>
      threadMatchesListFilter(thread, {
        hideCompleted: props.hideCompleted && !q,
        selectedTags:
          props.selectedTagsByProject[scopedProjectKey(thread.environmentId, thread.projectId)] ??
          [],
      }),
    );
    if (!q) return listed;
    return listed.filter((t) => {
      if (t.title.toLowerCase().includes(q)) return true;
      const key = scopedProjectKey(t.environmentId, t.projectId);
      return projectTitleByKey.get(key)?.toLowerCase().includes(q) ?? false;
    });
  }, [
    props.threads,
    props.searchQuery,
    props.hideCompleted,
    props.selectedTagsByProject,
    projectTitleByKey,
  ]);

  /* Search inside conversations on the server, alongside the instant title filter */
  const environmentIdsKey = useMemo(
    () => [...new Set(props.threads.map((thread) => thread.environmentId))].toSorted().join("|"),
    [props.threads],
  );
  const environmentIds = useMemo(
    () => (environmentIdsKey ? (environmentIdsKey.split("|") as EnvironmentId[]) : []),
    [environmentIdsKey],
  );
  const messageSearch = useThreadMessageSearch({ query: props.searchQuery, environmentIds });
  const messageHits = useMemo(() => {
    if (!messageSearch.active) return [];
    // A thread already listed above because its title matched isn't repeated here.
    const shown = new Set(filteredThreads.map((t) => threadKey(t.environmentId, t.id)));
    return messageSearch.results.filter(
      (result) => !shown.has(threadKey(result.environmentId, result.threadId)),
    );
  }, [messageSearch.active, messageSearch.results, filteredThreads]);

  /* Group filtered threads by project */
  const projectGroups = useMemo<ReadonlyArray<ProjectGroup>>(() => {
    const byProject = new Map<string, EnvironmentScopedThreadShell[]>();
    for (const thread of filteredThreads) {
      const key = scopedProjectKey(thread.environmentId, thread.projectId);
      const existing = byProject.get(key);
      if (existing) existing.push(thread);
      else byProject.set(key, [thread]);
    }

    // Fixed order: orchestrator first, then pinned conversations (in the order
    // they were pinned), then the remaining projects by most recent activity.
    const orchestratorGroups: ProjectGroup[] = [];
    const pinnedGroups: ProjectGroup[] = [];
    const activityGroups: ProjectGroup[] = [];
    for (const project of props.projects) {
      const key = scopedProjectKey(project.environmentId, project.id);
      const threads = byProject.get(key);
      if (!threads || threads.length === 0) continue;

      if (props.orchestratorProjectKeys.has(key)) {
        orchestratorGroups.push({ key, kind: "orchestrator", project, threads });
        continue;
      }

      const pinned = threads.filter((thread) => thread.pinnedAt);
      const unpinned = threads.filter((thread) => !thread.pinnedAt);
      if (pinned.length > 0) {
        pinnedGroups.push({
          key: `pinned:${key}`,
          kind: "pinned",
          project,
          threads: Arr.sort(
            pinned,
            Order.mapInput(Order.Number, (thread: EnvironmentScopedThreadShell) =>
              pinnedTime(thread),
            ),
          ),
        });
      }
      if (unpinned.length > 0) {
        activityGroups.push({ key, kind: "project", project, threads: unpinned });
      }
    }

    return [
      ...Arr.sort(orchestratorGroups, projectGroupActivityOrder),
      ...Arr.sort(
        pinnedGroups,
        Order.mapInput(Order.Number, (group: ProjectGroup) => pinnedTime(group.threads[0]!)),
      ),
      ...Arr.sort(activityGroups, projectGroupActivityOrder),
    ];
  }, [props.projects, props.orchestratorProjectKeys, filteredThreads]);

  /* Empty states */
  const hasAnyThreads = props.threads.length > 0;
  const hasResults = filteredThreads.length > 0 || messageHits.length > 0;
  const signedOutLabels = props.catalogState.signedOutEnvironmentLabels;
  const emptyState = deriveEmptyState({
    catalogState: props.catalogState,
    projectCount: props.projects.length,
  });

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      className="flex-1 bg-screen"
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingTop: 8,
        paddingBottom: 24,
        gap: 20,
      }}
    >
      {signedOutLabels.length > 0 ? (
        <EmptyState
          title={`Signed out of ${signedOutLabels.join(", ")}`}
          detail="This phone's sign-in has expired or been revoked, so chats can't load. Pair it again from the desktop app."
          actionLabel="Pair again"
          onAction={props.onAddConnection}
        />
      ) : null}
      {!hasAnyThreads && signedOutLabels.length > 0 ? null : !hasAnyThreads ? (
        <View>
          <EmptyState
            title={emptyState.title}
            detail={emptyState.detail}
            actionLabel={!props.catalogState.hasReadyEnvironment ? "Add environment" : undefined}
            onAction={!props.catalogState.hasReadyEnvironment ? props.onAddConnection : undefined}
          />
          {emptyState.loading ? (
            <View className="absolute right-5 top-5">
              <ActivityIndicator color={accentColor} />
            </View>
          ) : null}
        </View>
      ) : !hasResults && !messageSearch.pending ? (
        <EmptyState
          title="No results"
          detail={
            messageSearch.failed
              ? `No thread titles match "${props.searchQuery.trim()}", and searching inside conversations failed. Check the connection and try again.`
              : `Nothing matches "${props.searchQuery.trim()}" in thread titles or messages.`
          }
        />
      ) : (
        projectGroups.map((group) => {
          const connection = props.savedConnectionsById[group.project.environmentId];
          const isExpanded = expandedProjects.has(group.key);
          const visibleThreads = isExpanded
            ? group.threads
            : group.threads.slice(0, collapsedLimit(group.kind));

          return (
            <View key={group.key}>
              <ProjectGroupLabel
                project={group.project}
                kind={group.kind}
                totalThreadCount={group.threads.length}
                httpBaseUrl={connection?.httpBaseUrl ?? null}
                bearerToken={connection?.bearerToken ?? null}
                isExpanded={isExpanded}
                onToggleExpand={() => toggleExpanded(group.key)}
              />
              <View
                className="overflow-hidden rounded-[20px] bg-card"
                style={{ borderCurve: "continuous" }}
              >
                {visibleThreads.map((thread, i) => (
                  <ThreadRow
                    key={`${thread.environmentId}:${thread.id}`}
                    thread={thread}
                    projectCwd={group.project.workspaceRoot}
                    onPress={() => props.onSelectThread(thread)}
                    isLast={i === visibleThreads.length - 1}
                  />
                ))}
              </View>
            </View>
          );
        })
      )}
      {messageSearch.active && hasAnyThreads && (hasResults || messageSearch.pending) ? (
        <View>
          <View className="flex-row items-center gap-2.5 px-1 pb-2">
            <Text
              className="flex-1 text-[12px] font-t3-medium uppercase text-foreground-muted"
              style={{ letterSpacing: 0.5 }}
            >
              Found in messages
            </Text>
            {messageSearch.pending ? <ActivityIndicator size="small" color={accentColor} /> : null}
          </View>
          {messageHits.length > 0 ? (
            <View
              className="overflow-hidden rounded-[20px] bg-card"
              style={{ borderCurve: "continuous" }}
            >
              {messageHits.map((result, i) => (
                <MessageHitRow
                  key={threadKey(result.environmentId, result.threadId)}
                  result={result}
                  onPress={() => props.onSelectSearchResult(result)}
                  isLast={i === messageHits.length - 1}
                />
              ))}
            </View>
          ) : (
            <Text className="px-1 text-[13px] text-foreground-tertiary">
              {messageSearch.pending
                ? "Searching inside conversations…"
                : messageSearch.failed
                  ? "Couldn't search inside conversations."
                  : "No other conversations mention this."}
            </Text>
          )}
        </View>
      ) : null}
    </ScrollView>
  );
}
