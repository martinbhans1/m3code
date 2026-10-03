import { ArchiveIcon, ArchiveX, LoaderIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  defaultInstanceIdForDriver,
  type DesktopUpdateChannel,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import {
  DEFAULT_PROVIDER_USAGE_ALERT_AUTO_DISMISS_SECONDS,
  DEFAULT_PROVIDER_USAGE_ALERT_REPEAT_MINUTES,
  DEFAULT_PROVIDER_USAGE_ALERT_THRESHOLDS,
  DEFAULT_UNIFIED_SETTINGS,
} from "@t3tools/contracts/settings";
import {
  ORCHESTRATOR_ACCESS_LABELS,
  ORCHESTRATOR_ACCESS_ORDER,
  ORCHESTRATOR_OVERRIDE_DESCRIPTIONS,
  ORCHESTRATOR_OVERRIDE_LABELS,
  ORCHESTRATOR_OVERRIDE_ORDER,
} from "../../lib/orchestratorAccess";
import { createModelSelection } from "@t3tools/shared/model";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Result from "effect/Result";
import { APP_VERSION, HOSTED_APP_CHANNEL, HOSTED_APP_CHANNEL_LABEL } from "../../branding";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { isElectron } from "../../env";
import { buildHostedChannelSelectionUrl, type HostedAppChannel } from "../../hostedPairing";
import {
  CARET_THICKNESS_OPTIONS,
  DEFAULT_CARET_THICKNESS,
  THEME_DEFINITIONS,
  isValidEnvironment,
  isValidTheme,
  useCaretThickness,
  useChromeTint,
  useEnvironment,
  useSmoothCaret,
  useTheme,
  useUserMessageTint,
  type Theme,
} from "../../hooks/useTheme";
import {
  useShowInteractionModeControl,
  useShowRuntimeModeControl,
} from "../../hooks/useComposerControlPrefs";
import { SidebarTintControl } from "./SidebarTintControl";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useSystemNotificationPermission } from "../../hooks/useSystemNotificationPermission";
import type { SystemNotificationPermission } from "../../lib/systemNotifications";
import { useThreadActions } from "../../hooks/useThreadActions";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../../lib/desktopUpdateReactQuery";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { useShallow } from "zustand/react/shallow";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { formatRelativeTime, formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  hasOneClickUpdateProviderCandidate,
  isProviderUpdateActive,
  type ProviderUpdateCandidate,
} from "../ProviderUpdateLaunchNotification.logic";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";
import {
  buildProviderInstanceUpdatePatch,
  formatDiagnosticsDescription,
} from "./SettingsPanels.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsTabs,
  useRelativeTimeTick,
} from "./settingsLayout";
import { ProjectFavicon } from "../ProjectFavicon";
import { useServerObservability, useServerProviders } from "../../rpc/serverState";
import { parseProviderUsageAlertThresholds } from "../../providerUsageAlerts.logic";

/**
 * Categories for the General page. Everything used to live in one list, which
 * made a specific setting impossible to find; the sidebar keeps the top-level
 * areas and these split the largest of them by what the setting affects.
 */
const GENERAL_SETTINGS_TABS = [
  { id: "appearance", label: "Appearance" },
  { id: "chat", label: "Chat" },
  { id: "notifications", label: "Notifications" },
  { id: "orchestrator", label: "Orchestrator" },
  { id: "workspace", label: "Projects" },
  { id: "about", label: "About" },
] as const;

type GeneralSettingsTabId = (typeof GENERAL_SETTINGS_TABS)[number]["id"];

const GENERAL_SETTINGS_TAB_STORAGE_KEY = "t3:settings-general-tab";

function readStoredGeneralSettingsTab(): GeneralSettingsTabId {
  try {
    const stored = window.localStorage.getItem(GENERAL_SETTINGS_TAB_STORAGE_KEY);
    const match = GENERAL_SETTINGS_TABS.find((tab) => tab.id === stored);
    return match?.id ?? "appearance";
  } catch {
    return "appearance";
  }
}

const USAGE_ALERT_REPEAT_OPTIONS = [
  { minutes: 0, label: "Only when crossed" },
  { minutes: 30, label: "Every 30 minutes" },
  { minutes: 60, label: "Every hour" },
  { minutes: 180, label: "Every 3 hours" },
  { minutes: 360, label: "Every 6 hours" },
  { minutes: 720, label: "Every 12 hours" },
] as const;

function usageAlertRepeatLabel(minutes: number): string {
  const match = USAGE_ALERT_REPEAT_OPTIONS.find((option) => option.minutes === minutes);
  return match?.label ?? `Every ${minutes} minutes`;
}

const USAGE_ALERT_AUTO_DISMISS_OPTIONS = [
  { seconds: 0, label: "Until dismissed" },
  { seconds: 5, label: "After 5 seconds" },
  { seconds: 10, label: "After 10 seconds" },
  { seconds: 30, label: "After 30 seconds" },
  { seconds: 60, label: "After 1 minute" },
] as const;

function usageAlertAutoDismissLabel(seconds: number): string {
  const match = USAGE_ALERT_AUTO_DISMISS_OPTIONS.find((option) => option.seconds === seconds);
  return match?.label ?? `After ${seconds} seconds`;
}

const THEME_GROUPS = [
  {
    label: "Light",
    themes: THEME_DEFINITIONS.filter((definition) => definition.group === "Light"),
  },
  {
    label: "Dark",
    themes: THEME_DEFINITIONS.filter((definition) => definition.group === "Dark"),
  },
] as const;

function isSystemNotificationSettingDirty(settings: {
  readonly systemNotificationsEnabled: boolean;
  readonly systemNotifyOnTurnCompleted: boolean;
  readonly systemNotifyOnInputNeeded: boolean;
  readonly systemNotifyOnFailure: boolean;
  readonly systemNotificationsSuppressWhenFocused: boolean;
}): boolean {
  return (
    settings.systemNotificationsEnabled !== DEFAULT_UNIFIED_SETTINGS.systemNotificationsEnabled ||
    settings.systemNotifyOnTurnCompleted !== DEFAULT_UNIFIED_SETTINGS.systemNotifyOnTurnCompleted ||
    settings.systemNotifyOnInputNeeded !== DEFAULT_UNIFIED_SETTINGS.systemNotifyOnInputNeeded ||
    settings.systemNotifyOnFailure !== DEFAULT_UNIFIED_SETTINGS.systemNotifyOnFailure ||
    settings.systemNotificationsSuppressWhenFocused !==
      DEFAULT_UNIFIED_SETTINGS.systemNotificationsSuppressWhenFocused
  );
}

function systemNotificationStatusText(
  permission: SystemNotificationPermission,
): string | undefined {
  switch (permission) {
    case "unsupported":
      return "This browser cannot show system notifications.";
    case "denied":
      return "Blocked by the system. Allow notifications for this app in your OS or browser settings.";
    case "default":
      return "Permission has not been granted yet — turning this on asks for it.";
    case "granted":
      return undefined;
  }
}

function themeLabel(value: Theme): string {
  if (value === "system") return "System";
  return THEME_DEFINITIONS.find((definition) => definition.id === value)?.label ?? "System";
}

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

function withoutProviderInstanceKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  key: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[key];
  return next;
}

function withoutProviderInstanceFavorites(
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>,
  instanceId: ProviderInstanceId,
) {
  return favorites.filter((favorite) => favorite.provider !== instanceId);
}

const PROVIDER_SETTINGS = DRIVER_OPTIONS.map((definition) => ({
  provider: definition.value,
}));

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  useRelativeTimeTick();
  const lastCheckedRelative = lastCheckedAt ? formatRelativeTime(lastCheckedAt) : null;

  if (!lastCheckedRelative) {
    return null;
  }

  return (
    <span className="text-[11px] text-muted-foreground/60">
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  );
}

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const queryClient = useQueryClient();
  const updateStateQuery = useDesktopUpdateState();
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);

  const updateState = updateStateQuery.data ?? null;
  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";
  const selectedHostedAppChannel = hasDesktopBridge ? null : HOSTED_APP_CHANNEL;

  const handleUpdateChannelChange = useCallback(
    (channel: DesktopUpdateChannel) => {
      const bridge = window.desktopBridge;
      if (
        !bridge ||
        typeof bridge.setUpdateChannel !== "function" ||
        channel === selectedUpdateChannel
      ) {
        return;
      }

      setIsChangingUpdateChannel(true);
      void bridge
        .setUpdateChannel(channel)
        .then((state) => {
          setDesktopUpdateStateQueryData(queryClient, state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not change update track",
              description: error instanceof Error ? error.message : "Update track change failed.",
            }),
          );
        })
        .finally(() => {
          setIsChangingUpdateChannel(false);
        });
    },
    [queryClient, selectedUpdateChannel],
  );

  const handleButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: error instanceof Error ? error.message : "Download failed.",
            }),
          );
        });
      return;
    }

    if (action === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(
          updateState ?? { availableVersion: null, downloadedVersion: null },
        ),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "Install failed.",
            }),
          );
        });
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        setDesktopUpdateStateQueryData(queryClient, result.state);
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check for updates",
              description:
                result.state.message ?? "Automatic updates are not available in this build.",
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      });
  }, [queryClient, updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = { download: "Download", install: "Install" };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    action === "download" || action === "install"
      ? "Update available."
      : "Current version of the application.";

  return (
    <>
      <SettingsRow
        title={<AboutVersionTitle />}
        description={description}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant={action === "install" ? "default" : "outline"}
                  disabled={buttonDisabled}
                  onClick={handleButtonClick}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      {hasDesktopBridge ? (
        <SettingsRow
          title="Update track"
          description="Stable follows full releases. Nightly follows the nightly desktop channel and can switch back to stable immediately."
          control={
            <Select
              value={selectedUpdateChannel}
              onValueChange={(value) => {
                handleUpdateChannelChange(value as DesktopUpdateChannel);
              }}
            >
              <SelectTrigger
                className="w-full sm:w-40"
                aria-label="Update track"
                disabled={isChangingUpdateChannel}
              >
                <SelectValue>
                  {selectedUpdateChannel === "nightly" ? "Nightly" : "Stable"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  Stable
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  Nightly
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : selectedHostedAppChannel ? (
        <SettingsRow
          title="Update track"
          description="Switches the hosted app release channel."
          control={
            <Select
              value={selectedHostedAppChannel}
              onValueChange={(value) => {
                if (value === selectedHostedAppChannel) return;
                window.location.assign(
                  buildHostedChannelSelectionUrl({ channel: value as HostedAppChannel }),
                );
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Update track">
                <SelectValue>{HOSTED_APP_CHANNEL_LABEL}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  Latest
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  Nightly
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </>
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(settings.defaultModelEnabled || settings.defaultModelSelection !== null
        ? ["Default model"]
        : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(!Equal.equals(
        settings.providerUsageAlertThresholds,
        DEFAULT_UNIFIED_SETTINGS.providerUsageAlertThresholds,
      )
        ? ["Plan usage alerts"]
        : []),
      ...(settings.sidebarThreadPreviewCount !== DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount
        ? ["Visible threads"]
        : []),
      ...(settings.sidebarThreadShowMoreIncrement !==
      DEFAULT_UNIFIED_SETTINGS.sidebarThreadShowMoreIncrement
        ? ["Show more increment"]
        : []),
      ...(settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap
        ? ["Diff line wrapping"]
        : []),
      ...(settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace
        ? ["Diff whitespace changes"]
        : []),
      ...(settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar
        ? ["Auto-open task panel"]
        : []),
      ...(settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
        ? ["Assistant output"]
        : []),
      ...(Duration.toMillis(settings.automaticGitFetchInterval) !==
      Duration.toMillis(DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval)
        ? ["Automatic Git fetch interval"]
        : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.defaultOrchestratorThreadAccess !==
      DEFAULT_UNIFIED_SETTINGS.defaultOrchestratorThreadAccess
        ? ["Orchestrator access"]
        : []),
      ...(settings.orchestratorAccessOverride !==
      DEFAULT_UNIFIED_SETTINGS.orchestratorAccessOverride
        ? ["What the orchestrator can reach"]
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ["Add project base directory"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(settings.showThreadChangeRequestStatus !==
      DEFAULT_UNIFIED_SETTINGS.showThreadChangeRequestStatus
        ? ["Pull request status"]
        : []),
      ...(settings.showGitCounts !== DEFAULT_UNIFIED_SETTINGS.showGitCounts ? ["Git counts"] : []),
      ...(isSystemNotificationSettingDirty(settings) ? ["Conversation notifications"] : []),
      ...(isGitWritingModelDirty ? ["Git writing model"] : []),
    ],
    [
      isGitWritingModelDirty,
      settings.systemNotificationsEnabled,
      settings.systemNotifyOnTurnCompleted,
      settings.systemNotifyOnInputNeeded,
      settings.systemNotifyOnFailure,
      settings.systemNotificationsSuppressWhenFocused,
      settings.autoOpenPlanSidebar,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.showThreadChangeRequestStatus,
      settings.showGitCounts,
      settings.addProjectBaseDirectory,
      settings.defaultThreadEnvMode,
      settings.defaultOrchestratorThreadAccess,
      settings.orchestratorAccessOverride,
      settings.providerUsageAlertThresholds,
      settings.diffIgnoreWhitespace,
      settings.diffWordWrap,
      settings.automaticGitFetchInterval,
      settings.enableAssistantStreaming,
      settings.sidebarThreadPreviewCount,
      settings.sidebarThreadShowMoreIncrement,
      settings.timestampFormat,
      theme,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;

    setTheme("system");
    updateSettings({
      timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
      providerUsageAlertThresholds: [...DEFAULT_UNIFIED_SETTINGS.providerUsageAlertThresholds],
      diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
      diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
      sidebarThreadPreviewCount: DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount,
      sidebarThreadShowMoreIncrement: DEFAULT_UNIFIED_SETTINGS.sidebarThreadShowMoreIncrement,
      autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
      enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
      automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
      defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
      defaultModelEnabled: DEFAULT_UNIFIED_SETTINGS.defaultModelEnabled,
      defaultModelSelection: DEFAULT_UNIFIED_SETTINGS.defaultModelSelection,
      defaultOrchestratorThreadAccess: DEFAULT_UNIFIED_SETTINGS.defaultOrchestratorThreadAccess,
      orchestratorAccessOverride: DEFAULT_UNIFIED_SETTINGS.orchestratorAccessOverride,
      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
      confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
      confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
      showThreadChangeRequestStatus: DEFAULT_UNIFIED_SETTINGS.showThreadChangeRequestStatus,
      showGitCounts: DEFAULT_UNIFIED_SETTINGS.showGitCounts,
      systemNotificationsEnabled: DEFAULT_UNIFIED_SETTINGS.systemNotificationsEnabled,
      systemNotifyOnTurnCompleted: DEFAULT_UNIFIED_SETTINGS.systemNotifyOnTurnCompleted,
      systemNotifyOnInputNeeded: DEFAULT_UNIFIED_SETTINGS.systemNotifyOnInputNeeded,
      systemNotifyOnFailure: DEFAULT_UNIFIED_SETTINGS.systemNotifyOnFailure,
      systemNotificationsSuppressWhenFocused:
        DEFAULT_UNIFIED_SETTINGS.systemNotificationsSuppressWhenFocused,
      textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
    });
    onRestored?.();
  }, [changedSettingLabels, onRestored, setTheme, updateSettings]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

export function GeneralSettingsPanel() {
  const [activeTab, setActiveTab] = useState<GeneralSettingsTabId>(readStoredGeneralSettingsTab);
  const { theme, setTheme } = useTheme();
  const { environment, setEnvironment, definitions: environmentDefinitions } = useEnvironment();
  const { chromeTint, setChromeTint } = useChromeTint();
  const { userMessageTint, setUserMessageTint } = useUserMessageTint();
  const { smoothCaret, setSmoothCaret } = useSmoothCaret();
  const { caretThickness, setCaretThickness } = useCaretThickness();
  const [showInteractionModeControl, setShowInteractionModeControl] =
    useShowInteractionModeControl();
  const [showRuntimeModeControl, setShowRuntimeModeControl] = useShowRuntimeModeControl();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const {
    permission: systemNotificationPermission,
    requestPermission: requestSystemNotifications,
  } = useSystemNotificationPermission();
  const observability = useServerObservability();
  const serverProviders = useServerProviders();
  const diagnosticsDescription = formatDiagnosticsDescription({
    localTracingEnabled: observability?.localTracingEnabled ?? false,
    otlpTracesEnabled: observability?.otlpTracesEnabled ?? false,
    otlpTracesUrl: observability?.otlpTracesUrl,
    otlpMetricsEnabled: observability?.otlpMetricsEnabled ?? false,
    otlpMetricsUrl: observability?.otlpMetricsUrl,
  });

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const defaultModelSelection = settings.defaultModelSelection ?? textGenerationModelSelection;
  const gitModelInstanceEntries = sortProviderInstanceEntries(
    deriveProviderInstanceEntries(serverProviders),
  );
  const textGenInstanceEntry = gitModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );
  const defaultModelInstanceEntry = gitModelInstanceEntries.find(
    (entry) => entry.instanceId === defaultModelSelection.instanceId,
  );
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const gitModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    textGenInstanceId,
    textGenModel,
  );
  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(GENERAL_SETTINGS_TAB_STORAGE_KEY, activeTab);
    } catch {
      // Private mode — the tab simply resets to the first category next time.
    }
  }, [activeTab]);

  return (
    <SettingsPageContainer>
      <SettingsTabs
        label="Settings categories"
        tabs={GENERAL_SETTINGS_TABS}
        value={activeTab}
        onValueChange={setActiveTab}
      />

      {activeTab === "appearance" ? (
        <SettingsSection title="Appearance">
          <SettingsRow
            title="Theme"
            description="Choose how M3 Code looks across the app."
            resetAction={
              theme !== "system" ? (
                <SettingResetButton label="theme" onClick={() => setTheme("system")} />
              ) : null
            }
            control={
              <Select
                value={theme}
                onValueChange={(value) => {
                  if (isValidTheme(value)) {
                    setTheme(value);
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
                  <SelectValue>{themeLabel(theme)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="system">
                    System
                  </SelectItem>
                  {THEME_GROUPS.map((group) => (
                    <SelectGroup key={group.label}>
                      <SelectGroupLabel>{group.label}</SelectGroupLabel>
                      {group.themes.map((definition) => (
                        <SelectItem hideIndicator key={definition.id} value={definition.id}>
                          {definition.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            title="Ambient background"
            description="How lively the backdrop behind the sidebar and chat is. Works with any theme."
            control={
              <Select
                value={environment}
                onValueChange={(value) => {
                  if (isValidEnvironment(value)) {
                    setEnvironment(value);
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label="Ambient background">
                  <SelectValue>
                    {environmentDefinitions.find((definition) => definition.id === environment)
                      ?.label ?? environment}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {environmentDefinitions.map((definition) => (
                    <SelectItem hideIndicator key={definition.id} value={definition.id}>
                      {definition.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            title="Sidebar & header tint"
            description="Tint the sidebar and header (and the ambient glow) toward a hue you pick. Auto follows the theme."
            control={<SidebarTintControl value={chromeTint} onChange={setChromeTint} />}
          />

          <SettingsRow
            title="Your message color"
            description="Color your own chat messages so they are easy to spot when scrolling. Auto uses the plain bubble."
            control={
              <SidebarTintControl
                value={userMessageTint}
                onChange={setUserMessageTint}
                subject="your messages"
              />
            }
          />

          <SettingsRow
            title="Smooth caret"
            description="Animate the chat composer's text cursor so it glides between positions as you type and move."
            resetAction={
              smoothCaret ? (
                <SettingResetButton label="smooth caret" onClick={() => setSmoothCaret(false)} />
              ) : null
            }
            control={
              <Switch
                checked={smoothCaret}
                onCheckedChange={(checked) => setSmoothCaret(Boolean(checked))}
                aria-label="Smooth caret animation"
              />
            }
          />

          {smoothCaret ? (
            <SettingsRow
              title="Caret thickness"
              description="How wide the composer's smooth caret is drawn."
              resetAction={
                caretThickness !== DEFAULT_CARET_THICKNESS ? (
                  <SettingResetButton
                    label="caret thickness"
                    onClick={() => setCaretThickness(DEFAULT_CARET_THICKNESS)}
                  />
                ) : null
              }
              control={
                <Select
                  value={String(caretThickness)}
                  onValueChange={(value) => setCaretThickness(Number(value))}
                >
                  <SelectTrigger className="w-full sm:w-40" aria-label="Caret thickness">
                    <SelectValue>
                      {CARET_THICKNESS_OPTIONS.find((option) => option.value === caretThickness)
                        ?.label ?? `${caretThickness}px`}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {CARET_THICKNESS_OPTIONS.map((option) => (
                      <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          ) : null}

          <SettingsRow
            title="Time format"
            description="System default follows your browser or OS clock preference."
            resetAction={
              settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
                <SettingResetButton
                  label="time format"
                  onClick={() =>
                    updateSettings({
                      timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.timestampFormat}
                onValueChange={(value) => {
                  if (value === "locale" || value === "12-hour" || value === "24-hour") {
                    updateSettings({ timestampFormat: value });
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                  <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="locale">
                    {TIMESTAMP_FORMAT_LABELS.locale}
                  </SelectItem>
                  <SelectItem hideIndicator value="12-hour">
                    {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                  </SelectItem>
                  <SelectItem hideIndicator value="24-hour">
                    {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>
      ) : null}

      {activeTab === "chat" ? (
        <SettingsSection title="Composer">
          <SettingsRow
            title="Use a default model"
            description="Start new threads with your chosen model and account. When off, new threads inherit the current chat's model and reasoning options. Existing chats and drafts keep their selections."
            control={
              <Switch
                checked={settings.defaultModelEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({
                    defaultModelEnabled: Boolean(checked),
                    defaultModelSelection,
                  })
                }
                aria-label="Use a default model"
              />
            }
          />
          <SettingsRow
            title="Default model"
            description="Choose the model, account, and reasoning options to use when the default is enabled. Integrations can follow this choice when they create a thread."
            control={
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  activeInstanceId={defaultModelSelection.instanceId}
                  model={defaultModelSelection.model}
                  lockedProvider={null}
                  instanceEntries={gitModelInstanceEntries}
                  modelOptionsByInstance={gitModelOptionsByInstance}
                  triggerVariant="outline"
                  onInstanceModelChange={(instanceId, model) =>
                    updateSettings({
                      defaultModelSelection: createModelSelection(instanceId, model),
                    })
                  }
                />
                <TraitsPicker
                  provider={defaultModelInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND}
                  models={defaultModelInstanceEntry?.models ?? []}
                  model={defaultModelSelection.model}
                  prompt=""
                  onPromptChange={() => {}}
                  modelOptions={defaultModelSelection.options}
                  allowPromptInjectedEffort={false}
                  triggerVariant="outline"
                  onModelOptionsChange={(options) =>
                    updateSettings({
                      defaultModelSelection: createModelSelection(
                        defaultModelSelection.instanceId,
                        defaultModelSelection.model,
                        options,
                      ),
                    })
                  }
                />
              </div>
            }
          />
          <SettingsRow
            title="Plan mode button"
            description="Show the Build/Plan toggle in the chat composer. Hiding it leaves the mode where you last set it."
            resetAction={
              !showInteractionModeControl ? (
                <SettingResetButton
                  label="plan mode button"
                  onClick={() => setShowInteractionModeControl(true)}
                />
              ) : null
            }
            control={
              <Switch
                checked={showInteractionModeControl}
                onCheckedChange={(checked) => setShowInteractionModeControl(Boolean(checked))}
                aria-label="Show the plan mode button in the composer"
              />
            }
          />

          <SettingsRow
            title="Permission mode picker"
            description="Show the Supervised / Auto-accept edits / Full access picker in the chat composer. Hiding it keeps the mode you last chose."
            resetAction={
              !showRuntimeModeControl ? (
                <SettingResetButton
                  label="permission mode picker"
                  onClick={() => setShowRuntimeModeControl(true)}
                />
              ) : null
            }
            control={
              <Switch
                checked={showRuntimeModeControl}
                onCheckedChange={(checked) => setShowRuntimeModeControl(Boolean(checked))}
                aria-label="Show the permission mode picker in the composer"
              />
            }
          />

          <SettingsRow
            title="New threads"
            description="Pick the default workspace mode for newly created draft threads."
            resetAction={
              settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
                <SettingResetButton
                  label="new threads"
                  onClick={() =>
                    updateSettings({
                      defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.defaultThreadEnvMode}
                onValueChange={(value) => {
                  if (value === "local" || value === "worktree") {
                    updateSettings({ defaultThreadEnvMode: value });
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                  <SelectValue>
                    {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="local">
                    Local
                  </SelectItem>
                  <SelectItem hideIndicator value="worktree">
                    New worktree
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            title="Auto-open task panel"
            description="Open the right-side plan and task panel automatically when steps appear."
            resetAction={
              settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar ? (
                <SettingResetButton
                  label="auto-open task panel"
                  onClick={() =>
                    updateSettings({
                      autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.autoOpenPlanSidebar}
                onCheckedChange={(checked) =>
                  updateSettings({ autoOpenPlanSidebar: Boolean(checked) })
                }
                aria-label="Open the task panel automatically"
              />
            }
          />
        </SettingsSection>
      ) : null}

      {activeTab === "chat" ? (
        <SettingsSection title="Messages">
          <SettingsRow
            title="Assistant output"
            description="Show token-by-token output while a response is in progress."
            resetAction={
              settings.enableAssistantStreaming !==
              DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
                <SettingResetButton
                  label="assistant output"
                  onClick={() =>
                    updateSettings({
                      enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.enableAssistantStreaming}
                onCheckedChange={(checked) =>
                  updateSettings({ enableAssistantStreaming: Boolean(checked) })
                }
                aria-label="Stream assistant messages"
              />
            }
          />
        </SettingsSection>
      ) : null}

      {activeTab === "chat" ? (
        <SettingsSection title="Diffs">
          <SettingsRow
            title="Diff line wrapping"
            description="Set the default wrap state when the diff panel opens."
            resetAction={
              settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
                <SettingResetButton
                  label="diff line wrapping"
                  onClick={() =>
                    updateSettings({
                      diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.diffWordWrap}
                onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
                aria-label="Wrap diff lines by default"
              />
            }
          />

          <SettingsRow
            title="Hide whitespace changes"
            description="Set whether the diff panel ignores whitespace-only edits by default."
            resetAction={
              settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
                <SettingResetButton
                  label="diff whitespace changes"
                  onClick={() =>
                    updateSettings({
                      diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.diffIgnoreWhitespace}
                onCheckedChange={(checked) =>
                  updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
                }
                aria-label="Hide whitespace changes by default"
              />
            }
          />
        </SettingsSection>
      ) : null}

      {activeTab === "notifications" ? (
        <SettingsSection title="Conversation notifications">
          <SettingsRow
            title="Notify me outside the app"
            description="Raise a system notification when a conversation stops needing the agent and starts needing you. The conversation you already have open never notifies."
            status={systemNotificationStatusText(systemNotificationPermission)}
            resetAction={
              settings.systemNotificationsEnabled !==
              DEFAULT_UNIFIED_SETTINGS.systemNotificationsEnabled ? (
                <SettingResetButton
                  label="system notifications"
                  onClick={() =>
                    updateSettings({
                      systemNotificationsEnabled:
                        DEFAULT_UNIFIED_SETTINGS.systemNotificationsEnabled,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.systemNotificationsEnabled}
                onCheckedChange={(checked) => {
                  const nextEnabled = Boolean(checked);
                  updateSettings({ systemNotificationsEnabled: nextEnabled });
                  if (nextEnabled) {
                    void requestSystemNotifications();
                  }
                }}
                aria-label="Notify me outside the app"
              />
            }
          />

          <SettingsRow
            title="When a conversation finishes"
            description="The agent has replied and is waiting for your next message."
            control={
              <Switch
                checked={settings.systemNotifyOnTurnCompleted}
                disabled={!settings.systemNotificationsEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({ systemNotifyOnTurnCompleted: Boolean(checked) })
                }
                aria-label="Notify when a conversation finishes"
              />
            }
          />

          <SettingsRow
            title="When a conversation needs an answer"
            description="An approval, a question, or a plan waiting to be reviewed."
            control={
              <Switch
                checked={settings.systemNotifyOnInputNeeded}
                disabled={!settings.systemNotificationsEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({ systemNotifyOnInputNeeded: Boolean(checked) })
                }
                aria-label="Notify when a conversation needs an answer"
              />
            }
          />

          <SettingsRow
            title="When a conversation fails"
            description="The agent or its session stopped with an error."
            control={
              <Switch
                checked={settings.systemNotifyOnFailure}
                disabled={!settings.systemNotificationsEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({ systemNotifyOnFailure: Boolean(checked) })
                }
                aria-label="Notify when a conversation fails"
              />
            }
          />

          <SettingsRow
            title="Only while the app is in the background"
            description="Off by default, so a conversation in another project still reaches you while you are working in this window."
            control={
              <Switch
                checked={settings.systemNotificationsSuppressWhenFocused}
                disabled={!settings.systemNotificationsEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({ systemNotificationsSuppressWhenFocused: Boolean(checked) })
                }
                aria-label="Only notify while the app is in the background"
              />
            }
          />
        </SettingsSection>
      ) : null}

      {activeTab === "notifications" ? (
        <SettingsSection title="Plan usage alerts">
          <SettingsRow
            title="Plan usage alerts"
            description="Show a persistent notification when any provider limit reaches a threshold. Enter comma-separated percentages; leave blank to disable."
            resetAction={
              !Equal.equals(
                settings.providerUsageAlertThresholds,
                DEFAULT_PROVIDER_USAGE_ALERT_THRESHOLDS,
              ) ? (
                <SettingResetButton
                  label="plan usage alerts"
                  onClick={() =>
                    updateSettings({
                      providerUsageAlertThresholds: [...DEFAULT_PROVIDER_USAGE_ALERT_THRESHOLDS],
                    })
                  }
                />
              ) : null
            }
            control={
              <DraftInput
                className="w-full sm:w-40"
                value={settings.providerUsageAlertThresholds.join(", ")}
                onCommit={(value) =>
                  updateSettings({
                    providerUsageAlertThresholds: parseProviderUsageAlertThresholds(value),
                  })
                }
                placeholder="50, 80"
                spellCheck={false}
                aria-label="Plan usage alert thresholds"
              />
            }
          />

          <SettingsRow
            title="Repeat reminders"
            description="How often to re-announce a limit that is still above a threshold you have already been told about."
            resetAction={
              settings.providerUsageAlertRepeatMinutes !==
              DEFAULT_PROVIDER_USAGE_ALERT_REPEAT_MINUTES ? (
                <SettingResetButton
                  label="usage alert repeat"
                  onClick={() =>
                    updateSettings({
                      providerUsageAlertRepeatMinutes: DEFAULT_PROVIDER_USAGE_ALERT_REPEAT_MINUTES,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={String(settings.providerUsageAlertRepeatMinutes)}
                onValueChange={(value) =>
                  updateSettings({ providerUsageAlertRepeatMinutes: Number(value) })
                }
              >
                <SelectTrigger className="w-full sm:w-52" aria-label="Plan usage alert repeat">
                  <SelectValue>
                    {usageAlertRepeatLabel(settings.providerUsageAlertRepeatMinutes)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {USAGE_ALERT_REPEAT_OPTIONS.map((option) => (
                    <SelectItem hideIndicator key={option.minutes} value={String(option.minutes)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            title="Dismiss automatically"
            description="How long a usage alert stays on screen. The countdown pauses while the app is in the background."
            resetAction={
              settings.providerUsageAlertAutoDismissSeconds !==
              DEFAULT_PROVIDER_USAGE_ALERT_AUTO_DISMISS_SECONDS ? (
                <SettingResetButton
                  label="usage alert auto-dismiss"
                  onClick={() =>
                    updateSettings({
                      providerUsageAlertAutoDismissSeconds:
                        DEFAULT_PROVIDER_USAGE_ALERT_AUTO_DISMISS_SECONDS,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={String(settings.providerUsageAlertAutoDismissSeconds)}
                onValueChange={(value) =>
                  updateSettings({ providerUsageAlertAutoDismissSeconds: Number(value) })
                }
              >
                <SelectTrigger className="w-full sm:w-52" aria-label="Plan usage alert dismissal">
                  <SelectValue>
                    {usageAlertAutoDismissLabel(settings.providerUsageAlertAutoDismissSeconds)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {USAGE_ALERT_AUTO_DISMISS_OPTIONS.map((option) => (
                    <SelectItem hideIndicator key={option.seconds} value={String(option.seconds)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>
      ) : null}

      {activeTab === "orchestrator" ? (
        <SettingsSection title="Orchestrator">
          <SettingsRow
            title="What the orchestrator can reach"
            description={`Overrides every per-conversation setting at once. ${ORCHESTRATOR_OVERRIDE_DESCRIPTIONS[settings.orchestratorAccessOverride]} Also on the orchestrator's own composer, next to its model picker.`}
            resetAction={
              settings.orchestratorAccessOverride !==
              DEFAULT_UNIFIED_SETTINGS.orchestratorAccessOverride ? (
                <SettingResetButton
                  label="orchestrator reach"
                  onClick={() =>
                    updateSettings({
                      orchestratorAccessOverride:
                        DEFAULT_UNIFIED_SETTINGS.orchestratorAccessOverride,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.orchestratorAccessOverride}
                onValueChange={(value) => {
                  if (!value) return;
                  updateSettings({
                    orchestratorAccessOverride: value as typeof settings.orchestratorAccessOverride,
                  });
                }}
              >
                <SelectTrigger
                  className="w-full sm:w-56"
                  aria-label="What the orchestrator can reach"
                >
                  <SelectValue>
                    {ORCHESTRATOR_OVERRIDE_LABELS[settings.orchestratorAccessOverride]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {ORCHESTRATOR_OVERRIDE_ORDER.map((override) => (
                    <SelectItem hideIndicator key={override} value={override}>
                      {ORCHESTRATOR_OVERRIDE_LABELS[override]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            title="Orchestrator access"
            description="How much of a conversation the orchestrator can see by default, for conversations you never set individually. Only consulted while the setting above is “Per conversation”."
            resetAction={
              settings.defaultOrchestratorThreadAccess !==
              DEFAULT_UNIFIED_SETTINGS.defaultOrchestratorThreadAccess ? (
                <SettingResetButton
                  label="orchestrator access"
                  onClick={() =>
                    updateSettings({
                      defaultOrchestratorThreadAccess:
                        DEFAULT_UNIFIED_SETTINGS.defaultOrchestratorThreadAccess,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.defaultOrchestratorThreadAccess}
                onValueChange={(value) => {
                  if (value === "none" || value === "watch" || value === "control") {
                    updateSettings({ defaultOrchestratorThreadAccess: value });
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-44" aria-label="Default orchestrator access">
                  <SelectValue>
                    {ORCHESTRATOR_ACCESS_LABELS[settings.defaultOrchestratorThreadAccess]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {ORCHESTRATOR_ACCESS_ORDER.map((access) => (
                    <SelectItem hideIndicator key={access} value={access}>
                      {ORCHESTRATOR_ACCESS_LABELS[access]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            title="Orchestrator model choices"
            description="Models the orchestrator may pick from when it opens a new conversation. Opus 5, GPT-5.6 Sol and GPT-6 Astra are enabled by default; clear the list to always inherit each project's default."
            resetAction={
              settings.orchestratorModelChoices.length > 0 ? (
                <SettingResetButton
                  label="orchestrator model choices"
                  onClick={() => updateSettings({ orchestratorModelChoices: [] })}
                />
              ) : null
            }
            control={
              <div className="flex flex-col items-end gap-2">
                {settings.orchestratorModelChoices.length > 0 ? (
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    {settings.orchestratorModelChoices.map((choice) => (
                      <span
                        key={`${choice.instanceId}:${choice.model}`}
                        className="inline-flex items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2 text-xs"
                      >
                        {choice.model}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="size-5 text-muted-foreground hover:text-foreground"
                          aria-label={`Remove ${choice.model}`}
                          onClick={() =>
                            updateSettings({
                              orchestratorModelChoices: settings.orchestratorModelChoices.filter(
                                (entry) =>
                                  !(
                                    entry.instanceId === choice.instanceId &&
                                    entry.model === choice.model
                                  ),
                              ),
                            })
                          }
                        >
                          <XIcon className="size-3" />
                        </Button>
                      </span>
                    ))}
                  </div>
                ) : null}
                <ProviderModelPicker
                  activeInstanceId={textGenInstanceId}
                  model=""
                  lockedProvider={null}
                  instanceEntries={gitModelInstanceEntries}
                  modelOptionsByInstance={gitModelOptionsByInstance}
                  triggerVariant="outline"
                  triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                  onInstanceModelChange={(instanceId, model) => {
                    // Adding, not selecting: the picker is being used as a menu of
                    // everything available, and the row below it is the real value.
                    const alreadyChosen = settings.orchestratorModelChoices.some(
                      (entry) => entry.instanceId === instanceId && entry.model === model,
                    );
                    if (alreadyChosen) return;
                    updateSettings({
                      orchestratorModelChoices: [
                        ...settings.orchestratorModelChoices,
                        createModelSelection(instanceId, model),
                      ],
                    });
                  }}
                />
              </div>
            }
          />
        </SettingsSection>
      ) : null}

      {activeTab === "orchestrator" ? (
        <SettingsSection title="Text generation">
          <SettingsRow
            title="Text generation model"
            description="Configure the model used for generated commit messages, PR titles, and similar Git text."
            resetAction={
              isGitWritingModelDirty ? (
                <SettingResetButton
                  label="text generation model"
                  onClick={() =>
                    updateSettings({
                      textGenerationModelSelection:
                        DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  activeInstanceId={textGenInstanceId}
                  model={textGenModel}
                  lockedProvider={null}
                  instanceEntries={gitModelInstanceEntries}
                  modelOptionsByInstance={gitModelOptionsByInstance}
                  triggerVariant="outline"
                  triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                  onInstanceModelChange={(instanceId, model) => {
                    updateSettings({
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...settings,
                          textGenerationModelSelection: createModelSelection(instanceId, model),
                        },
                        serverProviders,
                      ),
                    });
                  }}
                />
                <TraitsPicker
                  provider={textGenProvider}
                  models={
                    // Use the exact instance's models (rather than the
                    // first-kind-match) so a custom text-gen instance like
                    // `codex_personal` gets its own model list, not the
                    // default Codex one.
                    textGenInstanceEntry?.models ?? []
                  }
                  model={textGenModel}
                  prompt=""
                  onPromptChange={() => {}}
                  modelOptions={textGenModelOptions}
                  allowPromptInjectedEffort={false}
                  triggerVariant="outline"
                  triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                  onModelOptionsChange={(nextOptions) => {
                    updateSettings({
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...settings,
                          textGenerationModelSelection: createModelSelection(
                            textGenInstanceId,
                            textGenModel,
                            nextOptions,
                          ),
                        },
                        serverProviders,
                      ),
                    });
                  }}
                />
              </div>
            }
          />
        </SettingsSection>
      ) : null}

      {activeTab === "workspace" ? (
        <SettingsSection title="Projects & threads">
          <SettingsRow
            title="Add project starts in"
            description='Leave empty to use "~/" when the Add Project browser opens.'
            resetAction={
              settings.addProjectBaseDirectory !==
              DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
                <SettingResetButton
                  label="add project base directory"
                  onClick={() =>
                    updateSettings({
                      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                    })
                  }
                />
              ) : null
            }
            control={
              <DraftInput
                className="w-full sm:w-72"
                value={settings.addProjectBaseDirectory}
                onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
                placeholder="~/"
                spellCheck={false}
                aria-label="Add project base directory"
              />
            }
          />

          <SettingsRow
            title="Archive confirmation"
            description="Require a second click on the inline archive action before a thread is archived."
            resetAction={
              settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
                <SettingResetButton
                  label="archive confirmation"
                  onClick={() =>
                    updateSettings({
                      confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.confirmThreadArchive}
                onCheckedChange={(checked) =>
                  updateSettings({ confirmThreadArchive: Boolean(checked) })
                }
                aria-label="Confirm thread archiving"
              />
            }
          />

          <SettingsRow
            title="Delete confirmation"
            description="Ask before deleting a thread and its chat history."
            resetAction={
              settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
                <SettingResetButton
                  label="delete confirmation"
                  onClick={() =>
                    updateSettings({
                      confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.confirmThreadDelete}
                onCheckedChange={(checked) =>
                  updateSettings({ confirmThreadDelete: Boolean(checked) })
                }
                aria-label="Confirm thread deletion"
              />
            }
          />

          <SettingsRow
            title="Git counts in the thread header"
            description="Show how many files are uncommitted and how many commits are waiting to be pushed, next to the branch name. Read from the git status already being streamed, so it costs nothing extra. Right-click a project in the sidebar to override this for that project alone."
            resetAction={
              settings.showGitCounts !== DEFAULT_UNIFIED_SETTINGS.showGitCounts ? (
                <SettingResetButton
                  label="git counts"
                  onClick={() =>
                    updateSettings({ showGitCounts: DEFAULT_UNIFIED_SETTINGS.showGitCounts })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.showGitCounts}
                onCheckedChange={(checked) => updateSettings({ showGitCounts: Boolean(checked) })}
                aria-label="Show git counts in the thread header"
              />
            }
          />

          <SettingsRow
            title="Pull request status on threads"
            description="Show a per-thread icon in the sidebar reflecting the status of its pull/merge request. Off by default — hide it if your projects don't use pull requests."
            resetAction={
              settings.showThreadChangeRequestStatus !==
              DEFAULT_UNIFIED_SETTINGS.showThreadChangeRequestStatus ? (
                <SettingResetButton
                  label="pull request status"
                  onClick={() =>
                    updateSettings({
                      showThreadChangeRequestStatus:
                        DEFAULT_UNIFIED_SETTINGS.showThreadChangeRequestStatus,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.showThreadChangeRequestStatus}
                onCheckedChange={(checked) =>
                  updateSettings({ showThreadChangeRequestStatus: Boolean(checked) })
                }
                aria-label="Show pull request status on threads"
              />
            }
          />
        </SettingsSection>
      ) : null}

      {activeTab === "about" ? (
        <SettingsSection title="About">
          {isElectron || HOSTED_APP_CHANNEL ? (
            <AboutVersionSection />
          ) : (
            <SettingsRow
              title={<AboutVersionTitle />}
              description="Current version of the application."
            />
          )}
          <SettingsRow
            title="Diagnostics"
            description={diagnosticsDescription}
            control={
              <Button render={<Link to="/settings/diagnostics" />} size="xs" variant="outline">
                View diagnostics
              </Button>
            }
          />
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

export function ProviderSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverProviders = useServerProviders();
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [updatingProviderDrivers, setUpdatingProviderDrivers] = useState<
    ReadonlySet<ProviderDriverKind>
  >(() => new Set());
  const [authenticatingProviderInstances, setAuthenticatingProviderInstances] = useState<
    ReadonlySet<ProviderInstanceId>
  >(() => new Set());
  const [openInstanceDetails, setOpenInstanceDetails] = useState<Record<string, boolean>>({});
  const refreshingRef = useRef(false);

  const providerUpdateCandidates = useMemo(
    () => collectProviderUpdateCandidates(serverProviders),
    [serverProviders],
  );
  const providerUpdateCandidateByInstanceId = useMemo(
    () => new Map(providerUpdateCandidates.map((candidate) => [candidate.instanceId, candidate])),
    [providerUpdateCandidates],
  );
  const visibleProviderSettings = PROVIDER_SETTINGS.filter(
    (providerSettings) =>
      providerSettings.provider !== "cursor" ||
      serverProviders.some(
        (provider) =>
          provider.instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("cursor")),
      ),
  );
  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void ensureLocalApi()
      .server.refreshProviders()
      .catch((error: unknown) => {
        console.warn("Failed to refresh providers", error);
      })
      .finally(() => {
        refreshingRef.current = false;
        setIsRefreshingProviders(false);
      });
  }, []);

  const runProviderUpdate = useCallback(async (candidate: ProviderUpdateCandidate) => {
    let started = false;
    setUpdatingProviderDrivers((previous) => {
      if (previous.has(candidate.driver)) {
        return previous;
      }
      started = true;
      const next = new Set(previous);
      next.add(candidate.driver);
      return next;
    });
    if (!started) {
      return;
    }

    try {
      await ensureLocalApi().server.updateProvider({
        provider: candidate.driver,
        instanceId: candidate.instanceId,
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not update ${PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver}`,
          description:
            error instanceof Error
              ? error.message
              : "The provider update command could not be started.",
        }),
      );
    } finally {
      setUpdatingProviderDrivers((previous) => {
        if (!previous.has(candidate.driver)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(candidate.driver);
        return next;
      });
    }
  }, []);

  const authenticateProvider = useCallback(async (instanceId: ProviderInstanceId) => {
    let started = false;
    setAuthenticatingProviderInstances((previous) => {
      if (previous.has(instanceId)) return previous;
      started = true;
      const next = new Set(previous);
      next.add(instanceId);
      return next;
    });
    if (!started) return;

    try {
      await ensureLocalApi().server.authenticateProvider({ instanceId });
      toastManager.add({
        type: "success",
        title: "Claude account connected",
        description: "The provider status was refreshed with the new credentials.",
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not sign in to Claude",
          description:
            error instanceof Error ? error.message : "The Claude sign-in flow did not complete.",
        }),
      );
    } finally {
      setAuthenticatingProviderInstances((previous) => {
        const next = new Set(previous);
        next.delete(instanceId);
        return next;
      });
    }
  }, []);

  interface InstanceRow {
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
    readonly driver: ProviderDriverKind;
    readonly isDefault: boolean;
    readonly isDirty?: boolean;
  }

  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const defaultSlotIdsBySource = new Set<string>(
    visibleProviderSettings.map((providerSettings) =>
      String(defaultInstanceIdForDriver(providerSettings.provider)),
    ),
  );

  const rows: InstanceRow[] = [];
  const visibleDriverKinds = new Set<ProviderDriverKind>(
    visibleProviderSettings.map((providerSettings) => providerSettings.provider),
  );

  for (const providerSettings of visibleProviderSettings) {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const legacyProviders = settings.providers as Record<string, LegacyProviderSettings>;
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings
    >;
    const driver = providerSettings.provider;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = settings.providerInstances?.[defaultInstanceId];
    const legacyConfig = legacyProviders[providerSettings.provider]!;
    const defaultLegacyConfig = defaultLegacyProviders[providerSettings.provider]!;
    const effectiveInstance: ProviderInstanceConfig =
      explicitInstance ??
      ({
        driver,
        enabled: legacyConfig.enabled,
        config: legacyConfig,
      } satisfies ProviderInstanceConfig);
    const isDirty =
      explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig);
    rows.push({
      instanceId: defaultInstanceId,
      instance: effectiveInstance,
      driver,
      isDefault: true,
      isDirty,
    });
    for (const [id, instance] of instancesByDriver.get(providerSettings.provider) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({ instanceId: id, instance, driver: instance.driver, isDefault: false });
    }
  }
  for (const [driver, list] of instancesByDriver) {
    if (visibleDriverKinds.has(driver)) continue;
    for (const [id, instance] of list) {
      rows.push({
        instanceId: id,
        instance,
        driver: instance.driver,
        isDefault: defaultSlotIdsBySource.has(String(id)),
      });
    }
  }

  const updateProviderInstance = (
    row: InstanceRow,
    next: ProviderInstanceConfig,
    options?: {
      readonly textGenerationModelSelection?: Parameters<
        typeof buildProviderInstanceUpdatePatch
      >[0]["textGenerationModelSelection"];
    },
  ) => {
    updateSettings(
      buildProviderInstanceUpdatePatch({
        settings,
        instanceId: row.instanceId,
        instance: next,
        driver: row.driver,
        isDefault: row.isDefault,
        textGenerationModelSelection: options?.textGenerationModelSelection,
      }),
    );
  };

  const deleteProviderInstance = (id: ProviderInstanceId) => {
    updateSettings({
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, id),
      providerModelPreferences: withoutProviderInstanceKey(settings.providerModelPreferences, id),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], id),
    });
  };

  const updateProviderModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>;
      readonly modelOrder: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutProviderInstanceKey(settings.providerModelPreferences, instanceId);
    updateSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : {
              ...rest,
              [instanceId]: {
                hiddenModels,
                modelOrder,
              },
            },
    });
  };

  const updateProviderFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavoriteModels: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(
        Arr.filterMap(nextFavoriteModels, (slug) => {
          const trimmedSlug = slug.trim();
          return trimmedSlug.length > 0 ? Result.succeed(trimmedSlug) : Result.failVoid;
        }),
      ),
    ];
    updateSettings({
      favorites: [
        ...withoutProviderInstanceFavorites(settings.favorites ?? [], instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  const resetDefaultInstance = (driverKind: ProviderDriverKind) => {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings | undefined
    >;
    const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
    const defaultLegacyProvider = defaultLegacyProviders[driverKind];
    if (defaultLegacyProvider === undefined) return;
    updateSettings({
      providers: {
        ...settings.providers,
        [driverKind]: defaultLegacyProvider,
      } as typeof settings.providers,
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, defaultInstanceId),
      providerModelPreferences: withoutProviderInstanceKey(
        settings.providerModelPreferences,
        defaultInstanceId,
      ),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], defaultInstanceId),
    });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Providers"
        headerAction={
          <div className="flex items-center gap-1.5">
            <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    onClick={() => setIsAddInstanceDialogOpen(true)}
                    aria-label="Add provider instance"
                  >
                    <PlusIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Add provider instance</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={isRefreshingProviders}
                    onClick={() => void refreshProviders()}
                    aria-label="Refresh provider status"
                  >
                    {isRefreshingProviders ? (
                      <LoaderIcon className="size-3 animate-spin" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh provider status</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {rows.map((row) => {
          const driverOption = getDriverOption(row.driver);
          const liveProvider = serverProviders.find(
            (candidate) => candidate.instanceId === row.instanceId,
          );
          const updateCandidate = liveProvider
            ? providerUpdateCandidateByInstanceId.get(liveProvider.instanceId)
            : undefined;
          const isDriverUpdateRunning =
            updateCandidate !== undefined &&
            (updatingProviderDrivers.has(updateCandidate.driver) ||
              serverProviders.some(
                (provider) =>
                  provider.driver === updateCandidate.driver && isProviderUpdateActive(provider),
              ));
          const showInlineUpdateButton =
            updateCandidate !== undefined &&
            hasOneClickUpdateProviderCandidate(updateCandidate, serverProviders);
          const canRunInlineUpdate =
            updateCandidate !== undefined &&
            canOneClickUpdateProviderCandidate(updateCandidate, serverProviders) &&
            !updatingProviderDrivers.has(updateCandidate.driver);
          const modelPreferences = settings.providerModelPreferences?.[row.instanceId] ?? {
            hiddenModels: [],
            modelOrder: [],
          };
          const favoriteModels = Arr.filterMap(settings.favorites ?? [], (favorite) =>
            favorite.provider === row.instanceId ? Result.succeed(favorite.model) : Result.failVoid,
          );
          const resetLabel = driverOption?.label ?? String(row.driver);
          const headerAction =
            row.isDefault && row.isDirty ? (
              <SettingResetButton
                label={`${resetLabel} provider settings`}
                onClick={() => resetDefaultInstance(row.driver)}
              />
            ) : null;
          return (
            <ProviderInstanceCard
              key={row.instanceId}
              instanceId={row.instanceId}
              instance={row.instance}
              driverOption={driverOption}
              liveProvider={liveProvider}
              isExpanded={openInstanceDetails[row.instanceId] ?? false}
              onExpandedChange={(open) =>
                setOpenInstanceDetails((existing) => ({
                  ...existing,
                  [row.instanceId]: open,
                }))
              }
              onUpdate={(next) => {
                const wasEnabled = row.instance.enabled ?? true;
                const isDisabling = next.enabled === false && wasEnabled;
                const shouldClearTextGen = isDisabling && textGenInstanceId === row.instanceId;
                if (shouldClearTextGen) {
                  updateProviderInstance(row, next, {
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  });
                } else {
                  updateProviderInstance(row, next);
                }
              }}
              onDelete={row.isDefault ? undefined : () => deleteProviderInstance(row.instanceId)}
              headerAction={headerAction}
              hiddenModels={modelPreferences.hiddenModels}
              favoriteModels={favoriteModels}
              modelOrder={modelPreferences.modelOrder}
              onHiddenModelsChange={(hiddenModels) =>
                updateProviderModelPreferences(row.instanceId, {
                  ...modelPreferences,
                  hiddenModels,
                })
              }
              onFavoriteModelsChange={(favoriteModels) =>
                updateProviderFavoriteModels(row.instanceId, favoriteModels)
              }
              onModelOrderChange={(modelOrder) =>
                updateProviderModelPreferences(row.instanceId, {
                  ...modelPreferences,
                  modelOrder,
                })
              }
              onRunUpdate={
                showInlineUpdateButton && updateCandidate
                  ? () => {
                      if (!canRunInlineUpdate) {
                        return;
                      }
                      void runProviderUpdate(updateCandidate);
                    }
                  : undefined
              }
              isUpdating={showInlineUpdateButton ? isDriverUpdateRunning : undefined}
              onAuthenticate={
                row.driver === "claudeAgent" && liveProvider?.installed
                  ? () => void authenticateProvider(row.instanceId)
                  : undefined
              }
              isAuthenticating={authenticatingProviderInstances.has(row.instanceId)}
            />
          );
        })}
      </SettingsSection>

      <AddProviderInstanceDialog
        open={isAddInstanceDialogOpen}
        onOpenChange={setIsAddInstanceDialogOpen}
      />
    </SettingsPageContainer>
  );
}

export function ArchivedThreadsPanel() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const environmentIds = useMemo(
    () => [...new Set(projects.map((project) => project.environmentId))],
    [projects],
  );
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(environmentIds);

  const archivedGroups = useMemo(() => {
    const projectsByEnvironmentAndId = new Map(
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.projects.map(
          (project) =>
            [
              `${environmentId}:${project.id}`,
              {
                id: project.id,
                environmentId,
                name: project.title,
                cwd: project.workspaceRoot,
              },
            ] as const,
        ),
      ),
    );
    const threads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((thread) => ({
        ...thread,
        environmentId,
      })),
    );

    const archivedProjects = Array.from(projectsByEnvironmentAndId.values());
    const groups: Array<{
      readonly project: (typeof archivedProjects)[number];
      readonly threads: Array<(typeof threads)[number]>;
    }> = [];
    for (const project of archivedProjects) {
      const projectThreads: Array<(typeof threads)[number]> = [];
      for (const thread of threads) {
        if (thread.projectId === project.id && thread.environmentId === project.environmentId) {
          projectThreads.push(thread);
        }
      }
      if (projectThreads.length > 0) {
        groups.push({
          project,
          threads: projectThreads.toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
        });
      }
    }
    return groups;
  }, [archivedSnapshots]);

  const handleArchivedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        try {
          await unarchiveThread(threadRef);
          refreshArchivedThreads();
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to unarchive thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (clicked === "delete") {
        await confirmAndDeleteThread(threadRef);
        refreshArchivedThreads();
      }
    },
    [confirmAndDeleteThread, refreshArchivedThreads, unarchiveThread],
  );

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection title="Archived threads">
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchive ? (
                  <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoadingArchive
                  ? "Loading archived threads"
                  : archiveError
                    ? "Could not load archived threads"
                    : "No archived threads"}
              </span>
            }
            description={
              isLoadingArchive
                ? "Checking connected environments."
                : (archiveError ?? "Archived threads will appear here.")
            }
          />
        </SettingsSection>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }) => (
          <SettingsSection
            key={project.id}
            title={project.name}
            icon={<ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />}
          >
            {projectThreads.map((thread) => (
              <SettingsRow
                key={thread.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void handleArchivedThreadContextMenu(
                    scopeThreadRef(thread.environmentId, thread.id),
                    {
                      x: event.clientX,
                      y: event.clientY,
                    },
                  );
                }}
                title={thread.title}
                description={
                  <>
                    Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                    {" \u00b7 Created "}
                    {formatRelativeTimeLabel(thread.createdAt)}
                  </>
                }
                control={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                    onClick={() =>
                      void unarchiveThread(scopeThreadRef(thread.environmentId, thread.id))
                        .then(() => refreshArchivedThreads())
                        .catch((error) => {
                          toastManager.add(
                            stackedThreadToast({
                              type: "error",
                              title: "Failed to unarchive thread",
                              description:
                                error instanceof Error ? error.message : "An error occurred.",
                            }),
                          );
                        })
                    }
                  >
                    <ArchiveX className="size-3.5" />
                    <span>Unarchive</span>
                  </Button>
                }
              />
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
