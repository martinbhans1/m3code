import type { EnvironmentId, ProjectReadFileResult } from "@t3tools/contracts";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, Text as NativeText, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { getEnvironmentClient } from "../../state/environment-session-registry";
import { useRemoteCatalog } from "../../state/use-remote-catalog";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useThemeColor } from "../../lib/useThemeColor";
import { AssistantMarkdownText } from "../threads/ThreadFeed";
import {
  fileBasename,
  isMarkdownFilePath,
  resolveThreadFileReadTarget,
  type ThreadFileReadTarget,
} from "./threadFileTarget";

type FileLoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly file: ProjectReadFileResult }
  | { readonly status: "error"; readonly message: string };

const LINE_HEIGHT = 18;

function firstRouteParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function useThreadFileContents(
  environmentId: EnvironmentId | null,
  target: ThreadFileReadTarget | null,
  reloadKey: number,
): FileLoadState {
  const [state, setState] = useState<FileLoadState>({ status: "loading" });
  const cwd = target?.cwd ?? null;
  const relativePath = target?.relativePath ?? null;

  useEffect(() => {
    if (!environmentId || !cwd || !relativePath) {
      setState({
        status: "error",
        message: "This link does not point at a file the app can find.",
      });
      return;
    }
    const client = getEnvironmentClient(environmentId);
    if (!client) {
      setState({ status: "error", message: "Not connected to this computer right now." });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });
    client.projects.readFile({ cwd, relativePath }).then(
      (file) => {
        if (!cancelled) setState({ status: "ready", file });
      },
      (error: unknown) => {
        if (cancelled) return;
        const detail =
          error && typeof error === "object" && "message" in error
            ? String((error as { message: unknown }).message)
            : "The file could not be read.";
        setState({ status: "error", message: detail });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cwd, environmentId, relativePath, reloadKey]);

  return state;
}

function SourceView(props: { readonly contents: string; readonly line: number | null }) {
  const listRef = useRef<FlatList<string>>(null);
  const lines = useMemo(() => props.contents.split(/\r?\n/), [props.contents]);
  const gutterWidth = String(lines.length).length * 8 + 12;
  const mutedColor = String(useThemeColor("--color-foreground-muted"));
  const foregroundColor = String(useThemeColor("--color-foreground"));
  const highlightColor = String(useThemeColor("--color-subtle"));
  const insets = useSafeAreaInsets();
  const targetIndex =
    props.line !== null ? Math.min(Math.max(props.line - 1, 0), lines.length - 1) : null;

  const scrollToTarget = useCallback(() => {
    if (targetIndex === null || targetIndex <= 0) return;
    listRef.current?.scrollToIndex({ index: targetIndex, viewPosition: 0.3, animated: false });
  }, [targetIndex]);

  return (
    <FlatList
      ref={listRef}
      data={lines}
      keyExtractor={(_, index) => String(index)}
      initialNumToRender={Math.max(60, (targetIndex ?? 0) + 30)}
      onLayout={scrollToTarget}
      onScrollToIndexFailed={({ averageItemLength, index }) => {
        // Rows wrap, so their height is unknown until rendered. Jump near the
        // line first, then land on it once that stretch has been laid out.
        listRef.current?.scrollToOffset({ offset: averageItemLength * index, animated: false });
        requestAnimationFrame(scrollToTarget);
      }}
      contentContainerStyle={{ paddingVertical: 12, paddingBottom: insets.bottom + 24 }}
      renderItem={({ item, index }) => (
        <View
          style={{
            flexDirection: "row",
            paddingRight: 12,
            backgroundColor: index === targetIndex ? highlightColor : undefined,
          }}
        >
          <NativeText
            style={{
              width: gutterWidth,
              paddingRight: 8,
              textAlign: "right",
              color: mutedColor,
              fontFamily: "ui-monospace",
              fontSize: 11,
              lineHeight: LINE_HEIGHT,
            }}
          >
            {index + 1}
          </NativeText>
          <NativeText
            selectable
            style={{
              flex: 1,
              color: foregroundColor,
              fontFamily: "ui-monospace",
              fontSize: 12,
              lineHeight: LINE_HEIGHT,
            }}
          >
            {item.length > 0 ? item : " "}
          </NativeText>
        </View>
      )}
    />
  );
}

/**
 * Shows a file a chat message linked to. The phone has no filesystem of its
 * own, so the contents come from the connected computer.
 */
export function ThreadFileRouteScreen() {
  const params = useLocalSearchParams<{ path?: string | string[] }>();
  const target = firstRouteParam(params.path);
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const { projects, threads } = useRemoteCatalog();
  const environmentId = selectedThread?.environmentId ?? null;
  const [reloadKey, setReloadKey] = useState(0);
  const isMarkdown = target !== null && isMarkdownFilePath(target);
  const [showSource, setShowSource] = useState(false);
  const insets = useSafeAreaInsets();
  const iconColor = String(useThemeColor("--color-icon"));

  const readTarget = useMemo(() => {
    if (!target) return null;
    return resolveThreadFileReadTarget({
      target,
      threadCwd: selectedThreadCwd,
      knownRoots: [
        ...projects
          .filter((project) => project.environmentId === environmentId)
          .map((project) => project.workspaceRoot),
        ...threads
          .filter((thread) => thread.environmentId === environmentId)
          .map((thread) => thread.worktreePath),
      ],
    });
  }, [environmentId, projects, selectedThreadCwd, target, threads]);

  const state = useThreadFileContents(environmentId, readTarget, reloadKey);
  const title = target ? fileBasename(target) : "File";

  return (
    <View className="flex-1 bg-sheet">
      <Stack.Screen
        options={{
          headerTitle: title,
          headerRight: isMarkdown
            ? () => (
                <Pressable hitSlop={8} onPress={() => setShowSource((value) => !value)}>
                  <Text className="font-t3-medium text-[15px]" style={{ color: iconColor }}>
                    {showSource ? "Preview" : "Source"}
                  </Text>
                </Pressable>
              )
            : undefined,
        }}
      />
      {state.status === "loading" ? (
        <View className="flex-1 items-center justify-center">
          <Text className="text-sm text-foreground-muted">Loading {title}...</Text>
        </View>
      ) : state.status === "error" ? (
        <View className="p-4">
          <EmptyState
            title="Couldn't open this file"
            detail={state.message}
            actionLabel="Try again"
            onAction={() => setReloadKey((value) => value + 1)}
          />
        </View>
      ) : (
        <View className="flex-1">
          {state.file.truncated ? (
            <Text className="px-4 pt-3 text-xs text-foreground-muted">
              Large file: showing the first part only.
            </Text>
          ) : null}
          {isMarkdown && !showSource ? (
            <ScrollView
              contentContainerStyle={{
                paddingHorizontal: 16,
                paddingTop: 12,
                paddingBottom: insets.bottom + 24,
              }}
            >
              <AssistantMarkdownText markdown={state.file.contents} />
            </ScrollView>
          ) : (
            <SourceView contents={state.file.contents} line={readTarget?.line ?? null} />
          )}
        </View>
      )}
    </View>
  );
}
