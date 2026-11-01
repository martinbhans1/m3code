import { MenuView } from "@react-native-menu/menu";
import type { FollowupState } from "@t3tools/shared/followups";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { buildFollowupMenuActions, parseFollowupMenuEvent } from "../../lib/followupMenu";
import { useThemeColor } from "../../lib/useThemeColor";
import { useSelectedThreadFollowups } from "../../state/use-selected-thread-followups";
import { AssistantMarkdownText } from "./ThreadFeed";

function plural(count: number): string {
  return `${count} suggested task${count === 1 ? "" : "s"}`;
}

/**
 * Titles only, so a long deck can be skimmed in one pass. All of a task's
 * actions sit behind the single button on its row, and the description is one
 * tap on the title away.
 */
export function FollowupsSheet() {
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const iconColor = useThemeColor("--color-icon");
  const {
    followups,
    busyId,
    threadBusy,
    projectChoices,
    onDismiss,
    onStartInNewConversation,
    onDoInThisConversation,
  } = useSelectedThreadFollowups();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = followups.find((followup) => followup.id === openId) ?? null;

  const menuActions = useMemo(
    () => buildFollowupMenuActions({ projectChoices, threadBusy }),
    [projectChoices, threadBusy],
  );

  // Two things can ask to close at once (the last task leaving, and "do it
  // here" finishing), and either can arrive after you swiped the sheet away. A
  // second back would pop the conversation itself.
  const closedRef = useRef(false);
  const close = useCallback(() => {
    if (closedRef.current || !navigation.isFocused()) {
      return;
    }
    closedRef.current = true;
    router.back();
  }, [navigation, router]);

  // The last task can leave from another device too, not only from a tap here.
  const [hadFollowups, setHadFollowups] = useState(false);
  useEffect(() => {
    if (followups.length > 0) {
      setHadFollowups(true);
    } else if (hadFollowups) {
      close();
    }
  }, [close, followups.length, hadFollowups]);

  const handleMenuEvent = useCallback(
    (followup: FollowupState, event: string) => {
      const choice = parseFollowupMenuEvent(event);
      if (!choice || busyId !== null) {
        return;
      }
      const work =
        choice.kind === "dismiss"
          ? onDismiss(followup)
          : choice.kind === "here"
            ? onDoInThisConversation(followup)
            : onStartInNewConversation(followup, choice.projectId);
      work.then(
        () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          // Doing it here means you want to watch it happen.
          if (choice.kind === "here") {
            close();
          } else {
            setOpenId(null);
          }
        },
        (error: unknown) => {
          Alert.alert(
            "That did not go through",
            error instanceof Error ? error.message : "Could not reach your computer.",
          );
        },
      );
    },
    [busyId, close, onDismiss, onDoInThisConversation, onStartInNewConversation],
  );

  const renderMenu = (followup: FollowupState, trigger: ReactNode) => (
    <MenuView
      actions={menuActions}
      themeVariant={colorScheme === "dark" ? "dark" : "light"}
      onPressAction={({ nativeEvent }) => handleMenuEvent(followup, nativeEvent.event)}
    >
      {trigger}
    </MenuView>
  );

  if (open) {
    const detail = open.detail?.trim() ?? "";
    const rationale = open.rationale?.trim() ?? "";
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <View className="flex-row items-center px-3 pb-1 pt-5">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to suggested tasks"
            className="flex-row items-center gap-1 p-2"
            onPress={() => setOpenId(null)}
          >
            <SymbolView name="chevron.left" size={14} tintColor={iconColor} type="monochrome" />
            <Text className="font-t3-medium text-sm text-foreground-secondary">All tasks</Text>
          </Pressable>
        </View>
        <ScrollView
          className="flex-1"
          contentContainerStyle={{
            gap: 12,
            paddingHorizontal: 20,
            paddingBottom: 24,
            paddingTop: 4,
          }}
        >
          <Text selectable className="font-t3-bold text-[20px] leading-[26px]">
            {open.title}
          </Text>
          {detail.length > 0 ? (
            <AssistantMarkdownText markdown={detail} />
          ) : (
            <Text className="text-sm text-foreground-muted">No description.</Text>
          )}
          {rationale.length > 0 ? (
            <Text selectable className="text-sm leading-5 text-foreground-secondary">
              <Text className="font-t3-bold text-sm text-foreground-secondary">Why: </Text>
              {rationale}
            </Text>
          ) : null}
        </ScrollView>
        <View className="px-5 pt-2" style={{ paddingBottom: Math.max(insets.bottom, 18) }}>
          {renderMenu(
            open,
            <View className="min-h-[48px] flex-row items-center justify-center gap-2 rounded-[18px] bg-primary px-4 py-3">
              {busyId === open.id ? (
                <ActivityIndicator size="small" />
              ) : (
                <Text className="font-t3-bold text-[15px] text-primary-foreground">Actions</Text>
              )}
            </View>,
          )}
        </View>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <Text className="px-5 pb-2 pt-6 font-t3-bold text-[17px]">{plural(followups.length)}</Text>
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: insets.bottom + 12 }}>
        {followups.map((followup) => (
          <View
            key={followup.id}
            className="flex-row items-center border-b border-border pl-5 pr-2"
          >
            <Pressable
              accessibilityRole="button"
              accessibilityHint="Opens the description"
              className="flex-1 py-3"
              onPress={() => setOpenId(followup.id)}
            >
              <Text numberOfLines={2} className="font-t3-medium text-[15px] leading-5">
                {followup.title}
              </Text>
            </Pressable>
            {busyId === followup.id ? (
              <View className="h-11 w-11 items-center justify-center">
                <ActivityIndicator size="small" />
              </View>
            ) : (
              renderMenu(
                followup,
                <View
                  accessibilityRole="button"
                  accessibilityLabel={`Actions for ${followup.title}`}
                  className="h-11 w-11 items-center justify-center"
                >
                  <SymbolView name="ellipsis" size={18} tintColor={iconColor} type="monochrome" />
                </View>,
              )
            )}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
