import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { KeyboardAvoidingLegendList } from "@legendapp/list/keyboard";
import { type LegendListRef } from "@legendapp/list/react-native";
import type { EnvironmentId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { SymbolView } from "expo-symbols";
import { useRouter } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Markdown,
  type CustomRenderers,
  type NodeStyleOverrides,
  type PartialMarkdownTheme,
} from "react-native-nitro-markdown";
import {
  Image,
  Linking,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  type ColorValue,
  type TextStyle,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { TouchableOpacity } from "react-native-gesture-handler";
import ImageViewing from "react-native-image-viewing";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
  type NativeMarkdownTextStyle,
  type SelectableMarkdownSkill,
} from "../../native/SelectableMarkdownText";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { CopyTextButton } from "../../components/CopyTextButton";
import {
  parseReviewCommentMessageSegments,
  type ReviewInlineComment,
} from "../review/reviewCommentSelection";
import { resolveNativeReviewDiffView } from "../diffs/nativeReviewDiffSurface";
import {
  buildNativeReviewDiffData,
  createNativeReviewDiffTheme,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
  NATIVE_REVIEW_DIFF_ROW_HEIGHT,
  NATIVE_REVIEW_DIFF_STYLE,
} from "../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../review/reviewModel";
import { cn } from "../../lib/cn";
import { buildThreadFileNavigation } from "../../lib/routes";
import type { MobileLayoutVariant } from "../../lib/mobileLayout";
import {
  MarkdownFileLinkHandlerProvider,
  MarkdownImageRendererProvider,
  useMarkdownFileLinkHandler,
  type MarkdownImageRenderer,
} from "@t3tools/mobile-markdown-text";
import { markdownFileIconSource } from "@t3tools/mobile-markdown-text/file-icons";
import {
  resolveMarkdownLinkPresentation,
  type MarkdownLinkPresentation,
} from "@t3tools/mobile-markdown-text/links";
import {
  deriveThreadFeedPresentation,
  type ThreadFeedEntry,
  type ThreadFeedLatestTurn,
} from "../../lib/threadActivity";
import { isThreadFeedNearEnd } from "../../lib/threadFeedLayout";
import { relativeTime } from "../../lib/time";
import { localImagePathFromHref, useAssetUrl } from "../../lib/assetUrls";
import { CollapsibleUserMessage } from "./CollapsibleUserMessage";

const THREAD_FEED_END_THRESHOLD = 80;
const MESSAGE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

function formatMessageTime(input: string): string {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    return "";
  }
  return MESSAGE_TIME_FORMATTER.format(timestamp);
}

export interface ThreadFeedProps {
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly httpBaseUrl: string | null;
  readonly bearerToken: string | null;
  readonly agentLabel: string;
  readonly latestTurn: ThreadFeedLatestTurn | null;
  readonly contentTopInset?: number;
  readonly contentBottomInset?: number;
  readonly layoutVariant?: MobileLayoutVariant;
  readonly composerExpanded?: boolean;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  /** Send a queued message now, into the running turn, instead of waiting. */
  readonly onSteerQueuedMessage?: (messageId: MessageId) => void;
}

/**
 * A chat attachment, fetched through a signed asset URL — the phone has no
 * other route to the file the server stored.
 */
const ThreadAttachmentImage = memo(function ThreadAttachmentImage(props: {
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string | null;
  readonly attachmentId: string;
  readonly className: string;
  readonly wrapperClassName?: string;
  readonly onPressImage: (uri: string) => void;
}) {
  const asset = useAssetUrl({
    environmentId: props.environmentId,
    httpBaseUrl: props.httpBaseUrl,
    resource: { _tag: "attachment", attachmentId: props.attachmentId },
  });
  const uri = asset.url;
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      className={props.wrapperClassName}
      disabled={!uri}
      onPress={() => {
        if (uri) props.onPressImage(uri);
      }}
    >
      {uri ? (
        <Image source={{ uri }} className={props.className} resizeMode="cover" />
      ) : (
        <View className={props.className} />
      )}
    </TouchableOpacity>
  );
});

/**
 * An image an agent put in its reply. Agents usually point at a screenshot on
 * the desktop's disk, which the phone cannot open, so local paths go through a
 * signed asset URL; web URLs load as they are.
 */
const ThreadMarkdownImage = memo(function ThreadMarkdownImage(props: {
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string | null;
  readonly href: string;
  readonly alt: string | null;
  readonly onPressImage: (uri: string) => void;
}) {
  const localPath = localImagePathFromHref(props.href);
  const asset = useAssetUrl({
    environmentId: localPath ? props.environmentId : null,
    httpBaseUrl: props.httpBaseUrl,
    resource: localPath ? { _tag: "local-image", path: localPath } : null,
  });
  const uri = localPath ? asset.url : props.href;
  const [aspectRatio, setAspectRatio] = useState(16 / 9);
  // Keyed to the URL so a refreshed link gets a fresh attempt.
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const unavailable =
    (uri !== null && failedUri === uri) || (localPath !== null && asset.status === "error");

  return (
    <View style={{ gap: 6 }}>
      {unavailable ? (
        <View className="items-center justify-center rounded-[10px] bg-neutral-200 px-4 py-6 dark:bg-neutral-800">
          <Text className="text-center font-sans text-[13px] text-foreground-muted">
            {localPath ? "This image is no longer on the computer." : "This image could not load."}
          </Text>
        </View>
      ) : (
        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={props.alt ?? "Image"}
          disabled={!uri}
          onPress={() => {
            if (uri) props.onPressImage(uri);
          }}
        >
          {uri ? (
            <Image
              source={{ uri }}
              resizeMode="contain"
              onLoad={(event) => {
                const { width, height } = event.nativeEvent.source;
                if (width > 0 && height > 0) setAspectRatio(width / height);
              }}
              onError={() => setFailedUri(uri)}
              className="w-full rounded-[10px] bg-neutral-200 dark:bg-neutral-800"
              style={{ aspectRatio }}
            />
          ) : (
            <View
              className="w-full rounded-[10px] bg-neutral-200 dark:bg-neutral-800"
              style={{ aspectRatio }}
            />
          )}
        </Pressable>
      )}
      {props.alt ? (
        <Text selectable className="font-sans text-xs leading-4 text-foreground-muted">
          {props.alt}
        </Text>
      ) : null}
    </View>
  );
});

function stripShellWrapper(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^\/bin\/zsh -lc ['"]?([\s\S]*?)['"]?$/);
  return (match?.[1] ?? trimmed).trim();
}

function compactActivityDetail(detail: string | null): string | null {
  if (!detail) {
    return null;
  }

  const cleaned = stripShellWrapper(detail).replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function buildActivityRows(
  activities: Extract<ThreadFeedEntry, { type: "activity-group" }>["activities"],
) {
  return activities.map((activity) => ({
    ...activity,
    detail: compactActivityDetail(activity.detail),
  }));
}

const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;

const MARKDOWN_COLORS = {
  light: {
    body: "#111111",
    strong: "#000000",
    link: "#2563eb",
    blockquoteBorder: "rgba(0, 0, 0, 0.08)",
    blockquoteBackground: "rgba(0, 0, 0, 0.02)",
    codeBackground: "rgba(0, 0, 0, 0.04)",
    codeText: "#262626",
    horizontalRule: "rgba(0, 0, 0, 0.08)",
    userBody: "#ffffff",
    userCodeBackground: "rgba(255, 255, 255, 0.22)",
    userCodeText: "#ffffff",
    userFenceBackground: "rgba(0, 0, 0, 0.16)",
    userFenceText: "#ffffff",
  },
  dark: {
    body: "#e5e5e5",
    strong: "#f5f5f5",
    link: "#60a5fa",
    blockquoteBorder: "rgba(255, 255, 255, 0.1)",
    blockquoteBackground: "rgba(255, 255, 255, 0.03)",
    codeBackground: "rgba(255, 255, 255, 0.06)",
    codeText: "#e5e5e5",
    horizontalRule: "rgba(255, 255, 255, 0.08)",
    userBody: "#ffffff",
    userCodeBackground: "rgba(255, 255, 255, 0.18)",
    userCodeText: "#ffffff",
    userFenceBackground: "rgba(0, 0, 0, 0.28)",
    userFenceText: "#ffffff",
  },
} as const;

interface MarkdownStyleSets {
  readonly user: MarkdownStyleSet;
  readonly assistant: MarkdownStyleSet;
}

interface MarkdownStyleSet {
  readonly theme: PartialMarkdownTheme;
  readonly styles: NodeStyleOverrides;
  readonly renderers: CustomRenderers;
  readonly nativeTextStyle: NativeMarkdownTextStyle;
}

interface ReviewCommentColors {
  readonly background: ColorValue;
  readonly border: ColorValue;
  readonly mutedBackground: ColorValue;
  readonly text: ColorValue;
  readonly mutedText: ColorValue;
  readonly codeBackground: ColorValue;
}

const failedMarkdownFaviconHosts = new Set<string>();
const markdownLinkStyles = StyleSheet.create({
  favicon: {
    width: 14,
    height: 14,
    borderRadius: 3,
    marginHorizontal: 3,
    transform: [{ translateY: 2 }],
  },
  file: {
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
    fontFamily: "DMSans_500Medium",
    fontSize: 13,
    lineHeight: 20,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  fileIcon: {
    width: 15,
    height: 15,
    marginRight: 4,
    transform: [{ translateY: 2 }],
  },
});

const MarkdownFileLinkChip = memo(function MarkdownFileLinkChip(props: {
  readonly presentation: Extract<MarkdownLinkPresentation, { kind: "file" }>;
  readonly style: TextStyle;
}) {
  const onPressFile = useMarkdownFileLinkHandler();
  const { target } = props.presentation;
  return (
    <NativeText
      onPress={onPressFile ? () => onPressFile(target) : undefined}
      style={[markdownLinkStyles.file, props.style]}
    >
      <Image
        source={markdownFileIconSource(props.presentation.icon)}
        style={markdownLinkStyles.fileIcon}
      />
      {props.presentation.label}
    </NativeText>
  );
});

const MarkdownExternalLink = memo(function MarkdownExternalLink(props: {
  readonly children: ReactNode;
  readonly color: string;
  readonly host: string;
  readonly href: string;
}) {
  const [failed, setFailed] = useState(() => failedMarkdownFaviconHosts.has(props.host));

  return (
    <NativeText
      onPress={() => {
        void Linking.openURL(props.href);
      }}
      style={{
        color: props.color,
        fontFamily: "DMSans_400Regular",
        textDecorationLine: "none",
      }}
    >
      {!failed ? (
        <Image
          source={{
            uri: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(props.host)}&sz=32`,
          }}
          style={markdownLinkStyles.favicon}
          onError={() => {
            failedMarkdownFaviconHosts.add(props.host);
            setFailed(true);
          }}
        />
      ) : (
        <NativeText style={{ color: props.color }}>{" ◉ "}</NativeText>
      )}
      {props.children}
    </NativeText>
  );
});

function useReviewCommentColors(): ReviewCommentColors {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const background = isDark ? "#151515" : "#ffffff";
  const border = isDark ? "#2a2a2a" : "#d7d7d7";
  const mutedBackground = isDark ? "#242424" : "#f2f2f2";
  const text = isDark ? "#f3f3f3" : "#111111";
  const mutedText = isDark ? "#8f8f8f" : "#666666";
  const codeBackground = isDark ? "#0f0f0f" : "#ffffff";

  return useMemo(
    () => ({
      background,
      border,
      mutedBackground,
      text,
      mutedText,
      codeBackground,
    }),
    [background, border, codeBackground, mutedBackground, mutedText, text],
  );
}

/** Markdown laid out exactly the way an assistant reply looks in the feed. */
export const AssistantMarkdownText = memo(function AssistantMarkdownText(props: {
  readonly markdown: string;
}) {
  const styles = useMarkdownStyles().assistant;
  if (hasNativeSelectableMarkdownText()) {
    return <SelectableMarkdownText markdown={props.markdown} textStyle={styles.nativeTextStyle} />;
  }
  return (
    <Markdown
      options={{ gfm: true }}
      renderers={styles.renderers}
      styles={styles.styles}
      theme={styles.theme}
    >
      {props.markdown}
    </Markdown>
  );
});

function useMarkdownStyles(): MarkdownStyleSets {
  const colorScheme = useColorScheme();
  const colors = MARKDOWN_COLORS[colorScheme === "dark" ? "dark" : "light"];
  const inlineChipBackground = String(useThemeColor("--color-subtle"));
  const inlineSkillBackground = String(useThemeColor("--color-inline-skill-background"));
  const inlineSkillForeground = String(useThemeColor("--color-inline-skill-foreground"));

  return useMemo(() => {
    const markdownBodyColor = colors.body;
    const markdownStrongColor = colors.strong;
    const markdownLinkColor = colors.link;
    const markdownBlockquoteBg = colors.blockquoteBackground;
    const markdownBlockquoteBorder = colors.blockquoteBorder;
    const markdownCodeBg = colors.codeBackground;
    const markdownCodeText = colors.codeText;
    const markdownHrColor = colors.horizontalRule;
    const markdownUserBodyColor = colors.userBody;
    const markdownUserCodeBg = colors.userCodeBackground;
    const markdownUserCodeText = colors.userCodeText;
    const markdownUserFenceBg = colors.userFenceBackground;
    const markdownUserFenceText = colors.userFenceText;

    const baseTheme: PartialMarkdownTheme = {
      colors: {
        text: markdownBodyColor,
        heading: markdownStrongColor,
        link: markdownLinkColor,
        blockquote: markdownBlockquoteBorder,
        border: markdownHrColor,
        surfaceLight: markdownBlockquoteBg,
        accent: markdownLinkColor,
        tableBorder: markdownHrColor,
        tableHeader: markdownBlockquoteBg,
        tableHeaderText: markdownStrongColor,
        tableRowOdd: "transparent",
        tableRowEven: "transparent",
      },
      spacing: {
        xs: 4,
        s: 4,
        m: 8,
        l: 8,
        xl: 16,
      },
      fontSizes: {
        s: 13,
        m: 15,
        h1: 20,
        h2: 18,
        h3: 16,
        h4: 14,
        h5: 14,
        h6: 14,
      },
      fontFamilies: {
        regular: "DMSans_400Regular",
        heading: "DMSans_700Bold",
        mono: "ui-monospace",
      },
      headingWeight: "700",
      borderRadius: {
        s: 4,
        m: 8,
        l: 12,
      },
      showCodeLanguage: false,
    };

    const baseStyles: NodeStyleOverrides = {
      document: { flexShrink: 1 },
      paragraph: { marginTop: 0, marginBottom: 10 },
      list: { marginTop: 4, marginBottom: 8 },
      list_item: { marginTop: 0, marginBottom: 4 },
      task_list_item: { marginTop: 0, marginBottom: 4 },
      text: { lineHeight: 22 },
      bold: {
        fontWeight: "700",
        color: markdownStrongColor,
        fontFamily: "DMSans_700Bold",
      },
      italic: { fontStyle: "italic" },
      link: {
        color: markdownLinkColor,
        textDecorationLine: "underline" as const,
      },
      blockquote: {
        borderLeftWidth: 2,
        borderLeftColor: markdownBlockquoteBorder,
        paddingLeft: 11,
        paddingVertical: 2,
        marginLeft: 0,
        marginVertical: 10,
      },
      heading: {
        fontFamily: "DMSans_700Bold",
        color: markdownStrongColor,
        marginTop: 18,
        marginBottom: 8,
      },
      horizontal_rule: {
        backgroundColor: markdownHrColor,
        height: 1,
        marginVertical: 12,
      },
    };

    const createMarkdownRenderers = (
      inlineBackgroundColor: string,
      inlineTextColor: string,
      blockBackgroundColor: string,
      blockTextColor: string,
    ): CustomRenderers => ({
      link: ({ children, href = "" }) => {
        const presentation = resolveMarkdownLinkPresentation(href);
        if (presentation.kind === "file") {
          return (
            <MarkdownFileLinkChip
              presentation={presentation}
              style={{
                backgroundColor: inlineBackgroundColor,
                borderColor: markdownHrColor,
                color: inlineTextColor,
              }}
            />
          );
        }
        if (presentation.kind === "external") {
          return (
            <MarkdownExternalLink
              href={presentation.href}
              host={presentation.host}
              color={markdownLinkColor}
            >
              {children}
            </MarkdownExternalLink>
          );
        }
        const linkHref = presentation.href;
        return (
          <NativeText
            onPress={
              linkHref
                ? () => {
                    void Linking.openURL(linkHref);
                  }
                : undefined
            }
            style={{
              color: markdownLinkColor,
              textDecorationLine: "underline",
            }}
          >
            {children}
          </NativeText>
        );
      },
      list: ({ node, Renderer, ordered = false, start = 1 }) => (
        <View style={{ marginTop: 2, marginBottom: 8 }}>
          {node.children?.map((child, index) => {
            const childKey = `${child.type}:${child.beg ?? "unknown"}:${child.end ?? "unknown"}`;
            if (child.type === "task_list_item") {
              return (
                <Renderer key={childKey} node={child} depth={1} inListItem parentIsText={false} />
              );
            }
            return (
              <View
                key={childKey}
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  marginBottom: 3,
                }}
              >
                <NativeText
                  style={{
                    width: ordered ? 22 : 12,
                    marginRight: 5,
                    color: inlineTextColor,
                    fontFamily: "DMSans_400Regular",
                    fontSize: 15,
                    lineHeight: 22,
                    textAlign: ordered ? "right" : "center",
                  }}
                >
                  {ordered ? `${start + index}.` : "•"}
                </NativeText>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Renderer node={child} depth={1} inListItem parentIsText={false} />
                </View>
              </View>
            );
          })}
        </View>
      ),
      code_inline: ({ content }) => {
        const value = content ?? "";
        const wrapsPoorly =
          value.length > 24 || value.includes("/") || value.includes("\\") || value.includes(":");
        return (
          <NativeText
            style={{
              color: inlineTextColor,
              fontFamily: "ui-monospace",
              fontSize: 12,
              lineHeight: 18,
              ...(wrapsPoorly
                ? { opacity: 0.82 }
                : {
                    backgroundColor: inlineBackgroundColor,
                    borderRadius: 4,
                    paddingHorizontal: 3,
                  }),
            }}
          >
            {value}
          </NativeText>
        );
      },
      code_block: ({ content, language }) => (
        <View
          style={{
            backgroundColor: blockBackgroundColor,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: markdownHrColor,
            marginVertical: 12,
            overflow: "hidden",
          }}
        >
          {language ? (
            <View
              style={{
                borderBottomWidth: 1,
                borderBottomColor: markdownHrColor,
                paddingHorizontal: 14,
                paddingVertical: 8,
              }}
            >
              <NativeText
                style={{
                  color: markdownBodyColor,
                  fontFamily: "ui-monospace",
                  fontSize: 12,
                  opacity: 0.7,
                  textTransform: "uppercase",
                }}
              >
                {language}
              </NativeText>
            </View>
          ) : null}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            bounces={false}
            contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 12 }}
          >
            <NativeText
              selectable
              style={{
                color: blockTextColor,
                fontFamily: "ui-monospace",
                fontSize: 12,
                lineHeight: 18,
              }}
            >
              {content}
            </NativeText>
          </ScrollView>
        </View>
      ),
    });

    const userTheme: PartialMarkdownTheme = {
      ...baseTheme,
      colors: {
        ...baseTheme.colors,
        text: markdownUserBodyColor,
        heading: markdownUserBodyColor,
        link: markdownUserBodyColor,
        code: markdownUserCodeText,
        codeBackground: markdownUserCodeBg,
        border: markdownUserFenceBg,
      },
    };
    const userStyles: NodeStyleOverrides = {
      ...baseStyles,
      paragraph: { marginTop: 0, marginBottom: 0 },
      bold: {
        fontWeight: "700",
        color: markdownUserBodyColor,
        fontFamily: "DMSans_700Bold",
      },
      heading: {
        ...baseStyles.heading,
        color: markdownUserBodyColor,
        marginTop: 8,
        marginBottom: 4,
      },
      link: {
        color: markdownUserBodyColor,
        textDecorationLine: "underline" as const,
      },
    };

    const assistantTheme: PartialMarkdownTheme = {
      ...baseTheme,
      colors: {
        ...baseTheme.colors,
        code: markdownCodeText,
        codeBackground: markdownCodeBg,
        border: markdownCodeBg,
      },
    };
    const assistantStyles: NodeStyleOverrides = {
      ...baseStyles,
    };

    return {
      user: {
        theme: userTheme,
        styles: userStyles,
        renderers: createMarkdownRenderers(
          markdownUserCodeBg,
          markdownUserCodeText,
          markdownUserFenceBg,
          markdownUserFenceText,
        ),
        nativeTextStyle: {
          color: markdownUserBodyColor,
          strongColor: markdownUserBodyColor,
          mutedColor: markdownUserBodyColor,
          linkColor: markdownUserBodyColor,
          codeColor: markdownUserCodeText,
          codeBackgroundColor: markdownUserCodeBg,
          codeBlockBackgroundColor: markdownUserFenceBg,
          fileBackgroundColor: "rgba(255, 255, 255, 0.12)",
          fileTextColor: "#ffffff",
          skillBackgroundColor: "rgba(217, 70, 239, 0.24)",
          skillTextColor: "#ffffff",
          quoteMarkerColor: markdownUserBodyColor,
          dividerColor: markdownUserBodyColor,
          fontSize: 15,
          lineHeight: 22,
          fontFamily: "DMSans_400Regular",
          headingFontFamily: "DMSans_700Bold",
          boldFontFamily: "DMSans_700Bold",
        },
      },
      assistant: {
        theme: assistantTheme,
        styles: assistantStyles,
        renderers: createMarkdownRenderers(
          markdownCodeBg,
          markdownCodeText,
          markdownCodeBg,
          markdownCodeText,
        ),
        nativeTextStyle: {
          color: markdownBodyColor,
          strongColor: markdownStrongColor,
          mutedColor: markdownBodyColor,
          linkColor: markdownLinkColor,
          codeColor: markdownCodeText,
          codeBackgroundColor: markdownCodeBg,
          codeBlockBackgroundColor: markdownCodeBg,
          fileBackgroundColor: inlineChipBackground,
          fileTextColor: markdownCodeText,
          skillBackgroundColor: inlineSkillBackground,
          skillTextColor: inlineSkillForeground,
          quoteMarkerColor: markdownBlockquoteBorder,
          dividerColor: markdownHrColor,
          fontSize: 15,
          lineHeight: 22,
          fontFamily: "DMSans_400Regular",
          headingFontFamily: "DMSans_700Bold",
          boldFontFamily: "DMSans_700Bold",
        },
      },
    };
  }, [colors, inlineChipBackground, inlineSkillBackground, inlineSkillForeground]);
}

function renderFeedEntry(
  info: { item: ThreadFeedEntry; index: number },
  props: Pick<
    ThreadFeedProps,
    "environmentId" | "httpBaseUrl" | "onSteerQueuedMessage" | "skills"
  > & {
    readonly copiedRowId: string | null;
    readonly expandedWorkGroups: Record<string, boolean>;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly terminalAssistantMessageIds: ReadonlySet<string>;
    readonly unsettledTurnId: TurnId | null;
    readonly onCopyWorkRow: (rowId: string, value: string) => void;
    readonly onToggleWorkGroup: (groupId: string) => void;
    readonly onToggleWorkRow: (rowId: string) => void;
    readonly onToggleTurnFold: (turnId: TurnId) => void;
    readonly onPressImage: (uri: string) => void;
    readonly iconSubtleColor: string | import("react-native").ColorValue;
    readonly userBubbleColor: string | import("react-native").ColorValue;
    readonly markdownStyles: MarkdownStyleSets;
    readonly reviewCommentColors: ReviewCommentColors;
    readonly reviewCommentBubbleWidth: number;
  },
) {
  const entry = info.item;
  const { markdownStyles, iconSubtleColor, userBubbleColor } = props;

  if (entry.type === "turn-fold") {
    // A stopped turn that never reached a tool call has nothing behind the row.
    if (!entry.expandable) {
      return (
        <View className="mb-3 min-h-11 flex-row items-center gap-2 border-b border-neutral-200/80 px-2 dark:border-white/[0.08]">
          <Text className="font-t3-medium text-sm tabular-nums text-foreground-muted">
            {entry.label}
          </Text>
        </View>
      );
    }

    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: entry.expanded }}
        onPress={() => props.onToggleTurnFold(entry.turnId)}
        hitSlop={4}
        className="mb-3 min-h-11 flex-row items-center gap-2 border-b border-neutral-200/80 px-2 dark:border-white/[0.08]"
      >
        <Text className="font-t3-medium text-sm tabular-nums text-foreground-muted">
          {entry.label}
        </Text>
        <SymbolView
          name={entry.expanded ? "chevron.down" : "chevron.right"}
          size={15}
          tintColor={iconSubtleColor}
          type="monochrome"
        />
      </Pressable>
    );
  }

  if (entry.type === "message") {
    const { message } = entry;
    const isUser = message.role === "user";
    const styles = isUser ? markdownStyles.user : markdownStyles.assistant;
    const timestampLabel = formatMessageTime(isUser ? message.createdAt : message.updatedAt);
    const attachments = message.attachments ?? [];
    const hasReviewCommentContext = message.text.includes("<review_comment");
    const assistantTurnStillInProgress =
      message.role === "assistant" &&
      props.unsettledTurnId !== null &&
      message.turnId === props.unsettledTurnId;
    const showAssistantMeta =
      message.role === "assistant" &&
      props.terminalAssistantMessageIds.has(message.id) &&
      !assistantTurnStillInProgress &&
      !message.streaming;

    if (isUser) {
      return (
        <View className="mb-5 items-end">
          <View
            className="max-w-[85%] gap-2 rounded-[20px] px-3.5 py-2.5"
            style={{
              backgroundColor: userBubbleColor,
              ...(hasReviewCommentContext ? { width: props.reviewCommentBubbleWidth } : null),
            }}
          >
            {message.text.trim().length > 0 ? (
              <CollapsibleUserMessage
                key={message.id}
                backgroundColor={userBubbleColor}
                lineHeight={styles.nativeTextStyle.lineHeight}
              >
                <UserMessageContent
                  text={message.text}
                  markdownStyles={styles}
                  reviewCommentColors={props.reviewCommentColors}
                  skills={props.skills}
                />
              </CollapsibleUserMessage>
            ) : null}
            {attachments.map((attachment) => (
              <ThreadAttachmentImage
                key={attachment.id}
                environmentId={props.environmentId}
                httpBaseUrl={props.httpBaseUrl}
                attachmentId={attachment.id}
                className="aspect-[1.3] w-full rounded-[14px] bg-white/15"
                onPressImage={props.onPressImage}
              />
            ))}
          </View>
          <View className="mt-1 flex-row items-center justify-end gap-1 pr-0.5">
            <Text className="font-t3-medium text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
              {timestampLabel}
            </Text>
            {message.text.trim().length > 0 ? (
              <CopyTextButton
                accessibilityLabel="Copy message"
                text={message.text}
                tintColor={iconSubtleColor}
                buttonSize={28}
                iconSize={13}
              />
            ) : null}
          </View>
        </View>
      );
    }

    // Skip empty assistant messages (no text, no attachments) — they would
    // render as an orphaned timestamp and break adjacent activity-group merging.
    if (message.text.trim().length === 0 && attachments.length === 0) {
      return null;
    }

    return (
      <View className={cn(showAssistantMeta ? "mb-5 px-1" : "mb-2 px-1")}>
        {message.text.trim().length > 0 ? (
          hasNativeSelectableMarkdownText() ? (
            <SelectableMarkdownText
              markdown={message.text}
              skills={props.skills}
              textStyle={styles.nativeTextStyle}
            />
          ) : (
            <Markdown
              options={{ gfm: true }}
              renderers={styles.renderers}
              styles={styles.styles}
              theme={styles.theme}
            >
              {message.text}
            </Markdown>
          )
        ) : null}
        {attachments.map((attachment) => (
          <ThreadAttachmentImage
            key={attachment.id}
            environmentId={props.environmentId}
            httpBaseUrl={props.httpBaseUrl}
            attachmentId={attachment.id}
            wrapperClassName="mt-1.5"
            className="aspect-[1.3] w-full rounded-[18px] bg-neutral-200 dark:bg-neutral-800"
            onPressImage={props.onPressImage}
          />
        ))}
        {showAssistantMeta ? (
          <View className="mt-1 flex-row items-center gap-1">
            <CopyTextButton
              accessibilityLabel="Copy message"
              text={message.text}
              tintColor={iconSubtleColor}
              buttonSize={28}
              iconSize={13}
            />
            <Text className="font-t3-medium text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
              {timestampLabel}
            </Text>
          </View>
        ) : null}
      </View>
    );
  }

  if (entry.type === "queued-message") {
    return (
      <View className="mb-5 items-end">
        <View
          className="max-w-[85%] gap-2 rounded-[22px] rounded-br-[6px] px-3.5 py-2.5 opacity-60"
          style={{ backgroundColor: userBubbleColor }}
        >
          <Text className="font-sans text-[15px] leading-[22px] text-white">
            {entry.queuedMessage.text}
          </Text>
          {entry.queuedMessage.attachments.length > 0 ? (
            <Text className="font-t3-medium text-xs text-white/75">
              {entry.queuedMessage.attachments.length} image
              {entry.queuedMessage.attachments.length === 1 ? "" : "s"} attached
            </Text>
          ) : null}
        </View>
        <View className="mt-1.5 flex-row items-center gap-2 px-1">
          <Text className="text-right font-t3-medium text-xs text-neutral-600 dark:text-neutral-400">
            {entry.sending ? "dispatching" : `${relativeTime(entry.createdAt)} • pending`}
          </Text>
          {!entry.sending && props.onSteerQueuedMessage ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Steer now"
              hitSlop={8}
              onPress={() => props.onSteerQueuedMessage?.(entry.queuedMessage.messageId)}
            >
              <Text className="font-t3-bold text-xs text-foreground">Steer now</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  const rows = buildActivityRows(entry.activities).filter(
    (activity) => !(activity.toolLike && activity.status === "neutral"),
  );
  if (rows.length === 0) {
    return null;
  }
  const isExpanded = props.expandedWorkGroups[entry.id] ?? false;
  const hasOverflow = rows.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleRows = hasOverflow && !isExpanded ? rows.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES) : rows;
  const hiddenCount = rows.length - visibleRows.length;
  const onlyToolRows = rows.every((row) => row.toolLike);
  const headerTitle = onlyToolRows
    ? rows.length === 1
      ? "1 tool call"
      : `${rows.length} tool calls`
    : "Work log";

  return (
    <View className="mb-3 rounded-[16px] border border-neutral-300/70 bg-background px-2 py-2.5 dark:border-white/[0.1] dark:bg-white/[0.035]">
      <View className="mb-1.5 flex-row items-center justify-between gap-3 px-2">
        <Text className="font-t3-medium text-xs text-foreground">{headerTitle}</Text>
        {hasOverflow ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: isExpanded }}
            onPress={() => props.onToggleWorkGroup(entry.id)}
            className="flex-row items-center gap-1"
          >
            <Text className="font-t3-medium text-xs text-foreground-muted">
              {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
            </Text>
            <SymbolView
              name={isExpanded ? "chevron.up" : "chevron.down"}
              size={12}
              tintColor={iconSubtleColor}
              type="monochrome"
            />
          </Pressable>
        ) : null}
      </View>
      {visibleRows.map((row, index) => (
        <Pressable
          key={row.id}
          accessibilityRole={row.fullDetail ? "button" : undefined}
          accessibilityState={
            row.fullDetail ? { expanded: props.expandedWorkRows[row.id] ?? false } : undefined
          }
          onPress={() => {
            if (row.fullDetail) {
              props.onToggleWorkRow(row.id);
            }
          }}
          onLongPress={() => props.onCopyWorkRow(row.id, row.copyText)}
          className={cn(
            "rounded-lg px-2 py-1.5",
            index > 0 && "border-t border-neutral-200/80 dark:border-white/[0.06]",
          )}
        >
          <View className="flex-row items-center gap-2">
            <View className="w-4 items-center justify-center">
              <SymbolView
                name={
                  row.status === "failure"
                    ? "xmark"
                    : row.status === "success"
                      ? "checkmark"
                      : row.status === "neutral"
                        ? "minus"
                        : "terminal"
                }
                size={row.status ? 11 : 13}
                tintColor={row.status === "failure" ? "#e11d48" : iconSubtleColor}
                type="monochrome"
              />
            </View>
            <Text
              className="min-w-0 flex-1 text-[12px] leading-[18px] text-neutral-700 dark:text-neutral-300"
              numberOfLines={props.expandedWorkRows[row.id] ? undefined : 1}
            >
              {row.detail ? `${row.summary} - ${row.detail}` : row.summary}
            </Text>
            {row.fullDetail ? (
              <SymbolView
                name={props.expandedWorkRows[row.id] ? "chevron.up" : "chevron.down"}
                size={11}
                tintColor={iconSubtleColor}
                type="monochrome"
              />
            ) : null}
            {props.copiedRowId === row.id ? (
              <Text className="shrink-0 font-t3-medium text-[10px] text-emerald-600 dark:text-emerald-400">
                Copied
              </Text>
            ) : null}
          </View>
          {row.fullDetail && props.expandedWorkRows[row.id] ? (
            <ScrollView
              horizontal
              nestedScrollEnabled
              directionalLockEnabled
              showsHorizontalScrollIndicator
              bounces={false}
              className="mt-2 rounded-lg bg-neutral-100 dark:bg-black/20"
              contentContainerStyle={{ paddingHorizontal: 10, paddingVertical: 8 }}
            >
              <Text
                selectable
                className="text-[11px] leading-[17px] text-neutral-600 dark:text-neutral-400"
                style={{ fontFamily: "ui-monospace" }}
              >
                {row.fullDetail}
              </Text>
            </ScrollView>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

function UserMessageContent(props: {
  readonly text: string;
  readonly markdownStyles: MarkdownStyleSet;
  readonly reviewCommentColors: ReviewCommentColors;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
}) {
  const segments = parseReviewCommentMessageSegments(props.text);
  const hasReviewComment = segments.some((segment) => segment.kind === "review-comment");
  if (!hasReviewComment) {
    if (hasNativeSelectableMarkdownText()) {
      return (
        <SelectableMarkdownText
          markdown={props.text}
          skills={props.skills}
          textStyle={props.markdownStyles.nativeTextStyle}
        />
      );
    }
    return (
      <Markdown
        options={{ gfm: true }}
        renderers={props.markdownStyles.renderers}
        styles={props.markdownStyles.styles}
        theme={props.markdownStyles.theme}
      >
        {props.text}
      </Markdown>
    );
  }

  return (
    <View className="w-full gap-2">
      {segments.map((segment) => {
        if (segment.kind === "review-comment") {
          return (
            <ReviewCommentCard
              key={segment.comment.id}
              comment={segment.comment}
              colors={props.reviewCommentColors}
            />
          );
        }

        const text = segment.text.trim();
        if (text.length === 0) {
          return null;
        }

        return hasNativeSelectableMarkdownText() ? (
          <SelectableMarkdownText
            key={segment.id}
            markdown={text}
            skills={props.skills}
            textStyle={props.markdownStyles.nativeTextStyle}
          />
        ) : (
          <Markdown
            key={segment.id}
            options={{ gfm: true }}
            renderers={props.markdownStyles.renderers}
            styles={props.markdownStyles.styles}
            theme={props.markdownStyles.theme}
          >
            {text}
          </Markdown>
        );
      })}
    </View>
  );
}

const ReviewCommentCard = memo(function ReviewCommentCard(props: {
  readonly comment: ReviewInlineComment;
  readonly colors: ReviewCommentColors;
}) {
  const colorScheme = useColorScheme();
  const appearanceScheme = colorScheme === "light" ? "light" : "dark";
  const NativeReviewDiffView = resolveNativeReviewDiffView();
  const patch = useMemo(() => buildReviewCommentPatch(props.comment), [props.comment]);
  const parsedDiff = useMemo(
    () => buildReviewParsedDiff(patch, `thread-review-comment:${props.comment.id}`),
    [patch, props.comment.id],
  );
  const nativeReviewDiffData = useMemo(() => buildNativeReviewDiffData(parsedDiff), [parsedDiff]);
  const compactNativeRows = useMemo(
    () => nativeReviewDiffData.rows.filter((row) => row.kind !== "file"),
    [nativeReviewDiffData.rows],
  );
  const nativeReviewDiffTheme = useMemo(
    () => createNativeReviewDiffTheme(appearanceScheme),
    [appearanceScheme],
  );
  const nativeRowsJson = useMemo(() => JSON.stringify(compactNativeRows), [compactNativeRows]);
  const nativeThemeJson = useMemo(
    () => JSON.stringify(nativeReviewDiffTheme),
    [nativeReviewDiffTheme],
  );
  const nativeStyleJson = useMemo(() => JSON.stringify(NATIVE_REVIEW_DIFF_STYLE), []);
  const nativeDiffHeight = useMemo(
    () =>
      Math.min(
        360,
        Math.max(
          112,
          compactNativeRows.length * NATIVE_REVIEW_DIFF_ROW_HEIGHT +
            NATIVE_REVIEW_DIFF_STYLE.fileHeaderVerticalMargin,
        ),
      ),
    [compactNativeRows.length],
  );
  const shouldRenderNativeDiff = NativeReviewDiffView != null && compactNativeRows.length > 0;

  return (
    <View
      className="w-full overflow-hidden rounded-[16px] border"
      style={{
        backgroundColor: props.colors.background,
        borderColor: props.colors.border,
        borderCurve: "continuous",
      }}
    >
      <View
        className="flex-row items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: props.colors.border }}
      >
        <View
          className="size-6 items-center justify-center rounded-[7px]"
          style={{ backgroundColor: props.colors.mutedBackground, borderCurve: "continuous" }}
        >
          <SymbolView
            name="doc.text"
            size={13}
            tintColor={props.colors.mutedText}
            type="monochrome"
          />
        </View>
        <View className="min-w-0 flex-1">
          <Text
            className="font-mono text-[12px] leading-[16px]"
            numberOfLines={1}
            style={{ color: props.colors.text }}
          >
            {compactFileName(props.comment.filePath)}
          </Text>
        </View>
      </View>
      {shouldRenderNativeDiff ? (
        <View
          className="border-t"
          collapsable={false}
          style={{
            backgroundColor: nativeReviewDiffTheme.background,
            borderColor: props.colors.border,
            height: nativeDiffHeight,
          }}
        >
          <NativeReviewDiffView
            collapsable={false}
            style={StyleSheet.absoluteFill}
            appearanceScheme={appearanceScheme}
            contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
            rowHeight={NATIVE_REVIEW_DIFF_ROW_HEIGHT}
            rowsJson={nativeRowsJson}
            styleJson={nativeStyleJson}
            themeJson={nativeThemeJson}
          />
        </View>
      ) : props.comment.diff.trim().length > 0 ? (
        <ScrollView
          horizontal
          nestedScrollEnabled
          directionalLockEnabled
          showsHorizontalScrollIndicator={false}
          bounces={false}
          className="border-t"
          style={{ backgroundColor: props.colors.codeBackground, borderColor: props.colors.border }}
          contentContainerStyle={{ padding: 10 }}
        >
          <NativeText
            selectable
            style={{
              color: props.colors.text,
              fontFamily: "ui-monospace",
              fontSize: 12,
              lineHeight: 18,
            }}
          >
            {props.comment.diff.trim()}
          </NativeText>
        </ScrollView>
      ) : null}
      {props.comment.text.length > 0 ? (
        <View className="border-t px-3 py-3" style={{ borderColor: props.colors.border }}>
          <Text
            selectable
            className="text-[15px] leading-[21px]"
            style={{ color: props.colors.text }}
          >
            {props.comment.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

function buildReviewCommentPatch(comment: ReviewInlineComment): string {
  if ((comment.fenceLanguage ?? "diff") !== "diff") {
    return "";
  }
  const diff = comment.diff.trim();
  if (!diff) {
    return "";
  }

  if (diff.startsWith("diff --git ")) {
    return diff;
  }

  const normalizedPath = comment.filePath.replaceAll("\\", "/");
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    `--- a/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    diff,
  ].join("\n");
}

function compactFileName(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const lastSlashIndex = normalized.lastIndexOf("/");
  return lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized;
}

export const ThreadFeed = memo(function ThreadFeed(props: ThreadFeedProps) {
  const listRef = useRef<LegendListRef>(null);
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const foldSettleFrameRef = useRef<number | null>(null);
  const foldSettleSecondFrameRef = useRef<number | null>(null);
  const suppressAutoFollowRef = useRef(false);
  const previousLatestTurnRef = useRef(props.latestTurn);
  const isNearEndRef = useRef(true);
  const initialScrollReadyRef = useRef(false);
  const lastContentHeightRef = useRef(0);
  const { width: viewportWidth } = useWindowDimensions();
  const [interactionState, setInteractionState] = useState<{
    readonly copiedRowId: string | null;
    readonly expandedWorkGroups: Record<string, boolean>;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly expandedTurnIds: ReadonlySet<TurnId>;
  }>({
    copiedRowId: null,
    expandedWorkGroups: {},
    expandedWorkRows: {},
    expandedTurnIds: new Set(),
  });
  const { copiedRowId, expandedWorkGroups, expandedWorkRows, expandedTurnIds } = interactionState;
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const horizontalPadding = props.layoutVariant === "split" ? 20 : 16;
  const contentWidth = Math.max(0, viewportWidth - horizontalPadding * 2);
  const reviewCommentBubbleWidth = Math.min(Math.max(280, contentWidth * 0.85), contentWidth);
  const insets = useSafeAreaInsets();
  const topContentInset = props.contentTopInset ?? insets.top + 44;
  const bottomContentInset = props.contentBottomInset ?? 18;

  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const userBubbleColor = useThemeColor("--color-user-bubble");
  const markdownStyles = useMarkdownStyles();
  const router = useRouter();
  const openFileLink = useCallback(
    (target: string) => {
      router.push(
        buildThreadFileNavigation(
          { environmentId: props.environmentId, threadId: props.threadId },
          target,
        ),
      );
    },
    [props.environmentId, props.threadId, router],
  );
  const reviewCommentColors = useReviewCommentColors();
  const listAppearanceData = useMemo(
    () => ({
      iconSubtleColor,
      markdownStyles,
      reviewCommentColors,
      userBubbleColor,
    }),
    [iconSubtleColor, markdownStyles, reviewCommentColors, userBubbleColor],
  );
  const presentedFeed = useMemo(
    () => deriveThreadFeedPresentation(props.feed, props.latestTurn, expandedTurnIds),
    [expandedTurnIds, props.feed, props.latestTurn],
  );
  const terminalAssistantMessageIds = useMemo(() => {
    const terminalIdsByTurn = new Map<TurnId, string>();
    for (const entry of props.feed) {
      if (entry.type === "message" && entry.message.role === "assistant" && entry.message.turnId) {
        terminalIdsByTurn.set(entry.message.turnId, entry.message.id);
      }
    }
    return new Set(terminalIdsByTurn.values());
  }, [props.feed]);
  const unsettledTurnId =
    props.latestTurn &&
    (props.latestTurn.completedAt === null || props.latestTurn.state === "running")
      ? props.latestTurn.turnId
      : null;

  const scrollToEnd = useCallback(() => {
    if (scrollFrameRef.current !== null) {
      return;
    }
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      listRef.current?.scrollToEnd({ animated: false });
    });
  }, []);

  const onListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent> | NativeScrollEvent) => {
      const scrollEvent = "nativeEvent" in event ? event.nativeEvent : event;
      const { contentInset, contentOffset, contentSize, layoutMeasurement } = scrollEvent;
      isNearEndRef.current = isThreadFeedNearEnd(
        {
          contentHeight: contentSize.height,
          viewportHeight: layoutMeasurement.height,
          offsetY: contentOffset.y,
          bottomInset: contentInset.bottom,
        },
        THREAD_FEED_END_THRESHOLD,
      );
    },
    [],
  );

  const onListContentSizeChange = useCallback(
    (_width: number, height: number) => {
      const contentGrew = height > lastContentHeightRef.current + 0.5;
      lastContentHeightRef.current = height;

      if (
        initialScrollReadyRef.current &&
        contentGrew &&
        isNearEndRef.current &&
        !suppressAutoFollowRef.current
      ) {
        scrollToEnd();
      }
    },
    [scrollToEnd],
  );

  const onListLoad = useCallback(() => {
    initialScrollReadyRef.current = true;
  }, []);

  useEffect(() => {
    const previous = previousLatestTurnRef.current;
    previousLatestTurnRef.current = props.latestTurn;
    if (!props.latestTurn || !previous) {
      return;
    }
    if (props.latestTurn.turnId === previous.turnId) {
      if (previous.state === "running" && props.latestTurn.state === "interrupted") {
        const interruptedTurnId = props.latestTurn.turnId;
        setInteractionState((current) => ({
          ...current,
          expandedTurnIds: new Set(current.expandedTurnIds).add(interruptedTurnId),
        }));
      }
      return;
    }
    setInteractionState((current) => {
      if (!current.expandedTurnIds.has(previous.turnId)) {
        return current;
      }
      const next = new Set(current.expandedTurnIds);
      next.delete(previous.turnId);
      return { ...current, expandedTurnIds: next };
    });
  }, [props.latestTurn]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimeoutRef.current) {
        clearTimeout(copyFeedbackTimeoutRef.current);
      }
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
      if (foldSettleFrameRef.current !== null) {
        cancelAnimationFrame(foldSettleFrameRef.current);
      }
      if (foldSettleSecondFrameRef.current !== null) {
        cancelAnimationFrame(foldSettleSecondFrameRef.current);
      }
    };
  }, []);

  const onCopyWorkRow = useCallback((rowId: string, value: string) => {
    void Clipboard.setStringAsync(value);
    void Haptics.selectionAsync();
    setInteractionState((current) => ({ ...current, copiedRowId: rowId }));
    if (copyFeedbackTimeoutRef.current) {
      clearTimeout(copyFeedbackTimeoutRef.current);
    }
    copyFeedbackTimeoutRef.current = setTimeout(() => {
      setInteractionState((current) =>
        current.copiedRowId === rowId ? { ...current, copiedRowId: null } : current,
      );
      copyFeedbackTimeoutRef.current = null;
    }, 1200);
  }, []);

  const onToggleWorkGroup = useCallback((groupId: string) => {
    setInteractionState((current) => ({
      ...current,
      expandedWorkGroups: {
        ...current.expandedWorkGroups,
        [groupId]: !(current.expandedWorkGroups[groupId] ?? false),
      },
    }));
  }, []);

  const onToggleWorkRow = useCallback((rowId: string) => {
    setInteractionState((current) => ({
      ...current,
      expandedWorkRows: {
        ...current.expandedWorkRows,
        [rowId]: !(current.expandedWorkRows[rowId] ?? false),
      },
    }));
  }, []);

  const onToggleTurnFold = useCallback((turnId: TurnId) => {
    suppressAutoFollowRef.current = true;
    if (foldSettleFrameRef.current !== null) {
      cancelAnimationFrame(foldSettleFrameRef.current);
    }
    if (foldSettleSecondFrameRef.current !== null) {
      cancelAnimationFrame(foldSettleSecondFrameRef.current);
    }
    setInteractionState((current) => {
      const next = new Set(current.expandedTurnIds);
      if (next.has(turnId)) {
        next.delete(turnId);
      } else {
        next.add(turnId);
      }
      return { ...current, expandedTurnIds: next };
    });
    foldSettleFrameRef.current = requestAnimationFrame(() => {
      foldSettleSecondFrameRef.current = requestAnimationFrame(() => {
        suppressAutoFollowRef.current = false;
        foldSettleFrameRef.current = null;
        foldSettleSecondFrameRef.current = null;
      });
    });
  }, []);

  const onPressImage = useCallback((uri: string) => {
    setExpandedImage(uri);
  }, []);

  const { environmentId, httpBaseUrl } = props;
  const renderMarkdownImage = useCallback<MarkdownImageRenderer>(
    ({ href, alt }) => {
      // Relative or made-up hrefs have nothing to load; keep the default.
      if (!localImagePathFromHref(href) && !/^(https?:|data:image\/)/i.test(href)) {
        return undefined;
      }
      return (
        <ThreadMarkdownImage
          environmentId={environmentId}
          httpBaseUrl={httpBaseUrl}
          href={href}
          alt={alt}
          onPressImage={onPressImage}
        />
      );
    },
    [environmentId, httpBaseUrl, onPressImage],
  );

  const renderItem = useCallback(
    (info: { item: ThreadFeedEntry; index: number }) =>
      renderFeedEntry(info, {
        environmentId: props.environmentId,
        copiedRowId,
        httpBaseUrl: props.httpBaseUrl,
        onSteerQueuedMessage: props.onSteerQueuedMessage,
        expandedWorkGroups,
        expandedWorkRows,
        terminalAssistantMessageIds,
        unsettledTurnId,
        onCopyWorkRow,
        onToggleWorkGroup,
        onToggleWorkRow,
        onToggleTurnFold,
        onPressImage,
        iconSubtleColor,
        userBubbleColor,
        markdownStyles,
        reviewCommentColors,
        reviewCommentBubbleWidth,
        skills: props.skills,
      }),
    [
      copiedRowId,
      expandedWorkGroups,
      expandedWorkRows,
      terminalAssistantMessageIds,
      unsettledTurnId,
      iconSubtleColor,
      userBubbleColor,
      markdownStyles,
      reviewCommentColors,
      reviewCommentBubbleWidth,
      onCopyWorkRow,
      onPressImage,
      onToggleTurnFold,
      onToggleWorkGroup,
      onToggleWorkRow,
      props.environmentId,
      props.httpBaseUrl,
      props.onSteerQueuedMessage,
      props.skills,
    ],
  );

  if (props.feed.length === 0) {
    return (
      <ScrollView
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior="never"
        contentInset={{ top: topContentInset, bottom: bottomContentInset }}
        contentOffset={{ x: 0, y: -topContentInset }}
        scrollIndicatorInsets={{ top: topContentInset, bottom: bottomContentInset }}
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: horizontalPadding,
        }}
      >
        <EmptyState
          title="No conversation yet"
          detail="Ask the agent to inspect the repo, run a command, or continue the active thread."
        />
      </ScrollView>
    );
  }

  return (
    <MarkdownFileLinkHandlerProvider value={openFileLink}>
      <MarkdownImageRendererProvider value={renderMarkdownImage}>
        <View style={{ flex: 1 }}>
          <KeyboardAvoidingLegendList
            ref={listRef}
            key={props.threadId}
            style={{ flex: 1 }}
            automaticallyAdjustsScrollIndicatorInsets={false}
            contentInset={{ top: 0, bottom: 0 }}
            scrollIndicatorInsets={{ top: topContentInset, bottom: 0 }}
            alignItemsAtEnd
            maintainScrollAtEnd={{
              animated: false,
              on: {
                dataChange: true,
                itemLayout: true,
                layout: true,
              },
            }}
            data={presentedFeed}
            extraData={listAppearanceData}
            renderItem={renderItem}
            keyExtractor={(entry) => `${entry.type}:${entry.id}`}
            getItemType={(entry) =>
              entry.type === "message" ? `message:${entry.message.role}` : entry.type
            }
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="none"
            estimatedItemSize={180}
            initialScrollAtEnd
            onContentSizeChange={onListContentSizeChange}
            onLoad={onListLoad}
            onScroll={onListScroll}
            scrollEventThrottle={16}
            ListHeaderComponent={<View style={{ height: topContentInset }} />}
            contentContainerStyle={{
              paddingTop: 12,
              paddingBottom: bottomContentInset,
              paddingHorizontal: horizontalPadding,
            }}
          />
        </View>

        <ImageViewing
          images={expandedImage ? [{ uri: expandedImage }] : []}
          imageIndex={0}
          visible={expandedImage !== null}
          onRequestClose={() => setExpandedImage(null)}
          swipeToCloseEnabled
          doubleTapToZoomEnabled
        />
      </MarkdownImageRendererProvider>
    </MarkdownFileLinkHandlerProvider>
  );
});
