import { useEffect, useRef } from "react";

import { useClientSettingsHydrated, useSettings } from "../hooks/useSettings";
import { formatPercentLabel } from "../lib/utils";
import { deriveProviderInstanceEntries } from "../providerInstances";
import {
  evaluateProviderUsageAlerts,
  loadProviderUsageAlertState,
  saveProviderUsageAlertState,
  type ProviderUsageAlertState,
} from "../providerUsageAlerts.logic";
import { useServerProviders } from "../rpc/serverState";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { formatProviderUsageResetLabel } from "./settings/providerStatus";
import { stackedThreadToast, toastManager } from "./ui/toast";

/** Global coordinator for configured plan-usage threshold alerts. */
export function ProviderUsageNotifications() {
  const providers = useServerProviders();
  const thresholds = useSettings((settings) => settings.providerUsageAlertThresholds);
  const repeatMinutes = useSettings((settings) => settings.providerUsageAlertRepeatMinutes);
  const autoDismissSeconds = useSettings(
    (settings) => settings.providerUsageAlertAutoDismissSeconds,
  );
  const settingsHydrated = useClientSettingsHydrated();
  // Seeded from storage so a reload does not re-announce usage the user has
  // already dismissed.
  const stateRef = useRef<ReadonlyMap<string, ProviderUsageAlertState> | null>(null);
  stateRef.current ??= loadProviderUsageAlertState();

  useEffect(() => {
    if (!settingsHydrated) return;

    const evaluation = evaluateProviderUsageAlerts({
      providers,
      thresholds,
      repeatMinutes,
      previous: stateRef.current ?? new Map(),
    });
    stateRef.current = evaluation.state;
    saveProviderUsageAlertState(evaluation.state);

    if (evaluation.alerts.length === 0) return;

    const entriesById = new Map(
      deriveProviderInstanceEntries(providers).map((entry) => [entry.instanceId, entry]),
    );

    for (const alert of evaluation.alerts) {
      const entry = entriesById.get(alert.instanceId);
      const displayName = entry?.displayName ?? String(alert.instanceId);
      const percentLabel = formatPercentLabel(alert.percent) ?? `${alert.percent}%`;
      const resetLabel = formatProviderUsageResetLabel(alert.resetsAt, Date.now());

      toastManager.add(
        stackedThreadToast({
          type: alert.percent >= 100 || alert.severity === "critical" ? "error" : "warning",
          title: `${displayName} ${alert.windowLabel} usage is ${percentLabel}`,
          description: `Reached your ${alert.threshold}% alert threshold.${
            resetLabel ? ` ${resetLabel}.` : ""
          }`,
          timeout: 0,
          data: {
            hideCopyButton: true,
            // Counts down only while the window is focused, so an alert raised
            // while the user is away is still there when they come back.
            ...(autoDismissSeconds > 0
              ? { dismissAfterVisibleMs: autoDismissSeconds * 1_000 }
              : {}),
            leadingIcon: entry ? (
              <ProviderInstanceIcon
                driverKind={entry.driverKind}
                displayName={entry.displayName}
                accentColor={entry.accentColor}
                className="size-4"
                iconClassName="size-4"
              />
            ) : undefined,
          },
        }),
      );
    }
  }, [autoDismissSeconds, providers, repeatMinutes, settingsHydrated, thresholds]);

  return null;
}
