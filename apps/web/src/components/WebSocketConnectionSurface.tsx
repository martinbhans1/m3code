import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";

import { type SlowRpcAckRequest, useSlowRpcAckRequests } from "../rpc/requestLatencyState";
import {
  getWsConnectionStatus,
  getWsConnectionUiState,
  setBrowserOnlineStatus,
  type WsConnectionStatus,
  type WsConnectionUiState,
  useWsConnectionStatus,
  WS_RECONNECT_MAX_ATTEMPTS,
} from "../rpc/wsConnectionState";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { getPrimaryEnvironmentConnection } from "../environments/runtime";

const FORCED_WS_RECONNECT_DEBOUNCE_MS = 5_000;
/**
 * `visible` covers the case `focus` misses: a phone browser suspends a
 * background tab, the socket dies unnoticed, and returning to the app fires
 * `visibilitychange` (and on bfcache restores, `pageshow`) but not always a
 * window `focus`. Without it the user stares at a stale UI until the backoff
 * timer happens to come round.
 */
type WsAutoReconnectTrigger = "focus" | "online" | "visible";

const connectionTimeFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  second: "2-digit",
});

function formatConnectionMoment(isoDate: string | null): string | null {
  if (!isoDate) {
    return null;
  }

  return connectionTimeFormatter.format(new Date(isoDate));
}

function formatRetryCountdown(nextRetryAt: string, nowMs: number): string {
  const remainingMs = Math.max(0, new Date(nextRetryAt).getTime() - nowMs);
  return `${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
}

function describeOfflineToast(): string {
  return "WebSocket disconnected. Waiting for network.";
}

function formatReconnectAttemptLabel(status: WsConnectionStatus): string {
  const maxAttempts = status.reconnectMaxAttempts ?? WS_RECONNECT_MAX_ATTEMPTS;
  const reconnectAttempt = Math.max(
    1,
    maxAttempts === null
      ? status.reconnectAttemptCount
      : Math.min(status.reconnectAttemptCount, maxAttempts),
  );
  return maxAttempts === null
    ? `Attempt ${reconnectAttempt}`
    : `Attempt ${reconnectAttempt}/${maxAttempts}`;
}

function describeExhaustedToast(): string {
  return "Retries exhausted trying to reconnect";
}

function getConnectionDisplayName(status: WsConnectionStatus): string {
  return status.connectionLabel?.trim() || "T3 Server";
}

function buildReconnectTitle(status: WsConnectionStatus): string {
  return `Disconnected from ${getConnectionDisplayName(status)}`;
}

function buildRecoveredTitle(status: WsConnectionStatus): string {
  return `Reconnected to ${getConnectionDisplayName(status)}`;
}

function describeRecoveredToast(
  previousDisconnectedAt: string | null,
  connectedAt: string | null,
): string {
  const reconnectedAtLabel = formatConnectionMoment(connectedAt);
  const disconnectedAtLabel = formatConnectionMoment(previousDisconnectedAt);

  if (disconnectedAtLabel && reconnectedAtLabel) {
    return `Disconnected at ${disconnectedAtLabel} and reconnected at ${reconnectedAtLabel}.`;
  }

  if (reconnectedAtLabel) {
    return `Connection restored at ${reconnectedAtLabel}.`;
  }

  return "Connection restored.";
}

function describeSlowRpcAckToast(requests: ReadonlyArray<SlowRpcAckRequest>): string {
  const count = requests.length;
  const thresholdSeconds = Math.round((requests[0]?.thresholdMs ?? 0) / 1000);

  return `${count} request${count === 1 ? "" : "s"} waiting longer than ${thresholdSeconds}s.`;
}

function SlowRpcAckRequestDetails({ requests }: { requests: ReadonlyArray<SlowRpcAckRequest> }) {
  return (
    <ul className="space-y-2.5 text-xs text-muted-foreground">
      {requests.map((req) => (
        <li
          className="min-w-0 border-border/50 border-b pb-2 last:border-b-0 last:pb-0"
          key={req.requestId}
        >
          <div className="wrap-break-word font-medium text-foreground">{req.tag}</div>
          <div className="mt-0.5 font-mono text-[10px] leading-snug opacity-90">
            {req.requestId}
          </div>
          <div className="mt-0.5 text-[10px] opacity-75">
            Started {formatConnectionMoment(req.startedAt) ?? req.startedAt}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * How long a connection gap has to last before it is worth telling the user
 * about.
 *
 * Nearly every drop recovers on the first retry a second or two later, and a
 * toast for those is pure noise: it trains the user to dismiss the surface
 * reflexively, so the one outage that actually needs attention gets dismissed
 * too. Nothing is shown until the gap outlives the window in which the client
 * would have quietly fixed it by itself.
 */
export const RECONNECT_NOTICE_GRACE_MS = 6_000;

/**
 * Losing the network is a slower, more visible failure than a dropped socket,
 * but mobile radios flap constantly while switching cells or waking, so the
 * offline surface gets a shorter grace window rather than none at all.
 */
export const OFFLINE_NOTICE_GRACE_MS = 3_000;

/**
 * Delay before the connection surface is allowed to appear, or `null` when
 * there is nothing to announce.
 */
export function getConnectionNoticeDelayMs(status: WsConnectionStatus): number | null {
  const uiState = getWsConnectionUiState(status);

  if (uiState === "connected" || uiState === "connecting") {
    return null;
  }

  // Never having connected at all, or having given up retrying, are terminal
  // states the user has to act on — those surface immediately.
  if (uiState === "error" || status.reconnectPhase === "exhausted") {
    return 0;
  }

  return uiState === "offline" ? OFFLINE_NOTICE_GRACE_MS : RECONNECT_NOTICE_GRACE_MS;
}

/**
 * Milliseconds left before the surface may be shown for the current gap.
 * Returns `null` when there is nothing to announce, and `0` when it is due.
 */
export function getConnectionNoticeRemainingMs(
  status: WsConnectionStatus,
  nowMs: number,
): number | null {
  const delayMs = getConnectionNoticeDelayMs(status);
  if (delayMs === null) {
    return null;
  }

  const startedAtMs =
    status.disconnectedAt === null ? nowMs : new Date(status.disconnectedAt).getTime();

  return Math.max(0, startedAtMs + delayMs - nowMs);
}

export function shouldAutoReconnect(
  status: WsConnectionStatus,
  trigger: WsAutoReconnectTrigger,
): boolean {
  const uiState = getWsConnectionUiState(status);

  if (trigger === "online") {
    return (
      uiState === "offline" ||
      uiState === "reconnecting" ||
      uiState === "error" ||
      status.reconnectPhase === "exhausted"
    );
  }

  return (
    status.online &&
    status.hasConnected &&
    (uiState === "reconnecting" || status.reconnectPhase === "exhausted")
  );
}

/** Waking a suspended tab is only a reconnect signal once it is actually visible. */
export function isDocumentWakeTrigger(visibilityState: DocumentVisibilityState): boolean {
  return visibilityState === "visible";
}

export function shouldRestartStalledReconnect(
  status: WsConnectionStatus,
  expectedNextRetryAt: string,
): boolean {
  return (
    status.reconnectPhase === "waiting" &&
    status.nextRetryAt === expectedNextRetryAt &&
    status.online &&
    status.hasConnected
  );
}

export function WebSocketConnectionCoordinator() {
  const status = useWsConnectionStatus();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastForcedReconnectAtRef = useRef(0);
  const toastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const toastResetTimerRef = useRef<number | null>(null);
  const previousUiStateRef = useRef<WsConnectionUiState>(getWsConnectionUiState(status));
  const previousDisconnectedAtRef = useRef<string | null>(status.disconnectedAt);
  // Whether the current gap has outlived its grace window. Recovery toasts are
  // gated on this too: announcing a reconnect the user was never told about is
  // just as noisy as announcing the drop.
  const [noticeArmed, setNoticeArmed] = useState(false);
  const announcedLossRef = useRef(false);

  const runReconnect = useEffectEvent((showFailureToast: boolean) => {
    if (toastResetTimerRef.current !== null) {
      window.clearTimeout(toastResetTimerRef.current);
      toastResetTimerRef.current = null;
    }
    lastForcedReconnectAtRef.current = Date.now();
    void getPrimaryEnvironmentConnection()
      .reconnect()
      .catch((error) => {
        if (!showFailureToast) {
          console.warn("Automatic WebSocket reconnect failed", { error });
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Reconnect failed",
            description:
              error instanceof Error ? error.message : "Unable to restart the WebSocket.",
            data: {
              dismissAfterVisibleMs: 8_000,
              hideCopyButton: true,
            },
          }),
        );
      });
  });
  const syncBrowserOnlineStatus = useEffectEvent(() => {
    setBrowserOnlineStatus(navigator.onLine !== false);
  });
  const triggerManualReconnect = useEffectEvent(() => {
    runReconnect(true);
  });
  const triggerAutoReconnect = useEffectEvent((trigger: WsAutoReconnectTrigger) => {
    const currentStatus =
      trigger === "online" ? setBrowserOnlineStatus(true) : getWsConnectionStatus();

    if (!shouldAutoReconnect(currentStatus, trigger)) {
      return;
    }
    if (Date.now() - lastForcedReconnectAtRef.current < FORCED_WS_RECONNECT_DEBOUNCE_MS) {
      return;
    }

    runReconnect(false);
  });

  useEffect(() => {
    const handleOnline = () => {
      triggerAutoReconnect("online");
    };
    const handleFocus = () => {
      triggerAutoReconnect("focus");
    };
    const handleVisibilityChange = () => {
      if (!isDocumentWakeTrigger(document.visibilityState)) {
        return;
      }
      syncBrowserOnlineStatus();
      triggerAutoReconnect("visible");
    };
    const handlePageShow = () => {
      handleVisibilityChange();
    };

    syncBrowserOnlineStatus();
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", syncBrowserOnlineStatus);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", syncBrowserOnlineStatus);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pageshow", handlePageShow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (status.reconnectPhase !== "waiting" || status.nextRetryAt === null) {
      return;
    }

    setNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [status.nextRetryAt, status.reconnectPhase]);

  useEffect(() => {
    if (
      status.reconnectPhase !== "waiting" ||
      status.nextRetryAt === null ||
      !status.online ||
      !status.hasConnected
    ) {
      return;
    }

    const nextRetryAt = status.nextRetryAt;
    const timeoutMs = Math.max(0, new Date(nextRetryAt).getTime() - Date.now()) + 1_500;
    const timeoutId = window.setTimeout(() => {
      const currentStatus = getWsConnectionStatus();
      if (!shouldRestartStalledReconnect(currentStatus, nextRetryAt)) {
        return;
      }

      runReconnect(false);
    }, timeoutMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    status.hasConnected,
    status.nextRetryAt,
    status.online,
    status.reconnectAttemptCount,
    status.reconnectPhase,
  ]);

  useEffect(() => {
    const remainingMs = getConnectionNoticeRemainingMs(status, Date.now());

    if (remainingMs === null) {
      setNoticeArmed(false);
      return;
    }

    if (remainingMs === 0) {
      setNoticeArmed(true);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setNoticeArmed(true);
    }, remainingMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [status]);

  useEffect(() => {
    const uiState = getWsConnectionUiState(status);
    const previousUiState = previousUiStateRef.current;
    const previousDisconnectedAt = previousDisconnectedAtRef.current;
    const shouldShowReconnectToast =
      noticeArmed && status.hasConnected && uiState === "reconnecting";
    const shouldShowOfflineToast =
      noticeArmed && uiState === "offline" && status.disconnectedAt !== null;
    const shouldShowExhaustedToast =
      noticeArmed && status.hasConnected && status.reconnectPhase === "exhausted";

    if (
      toastResetTimerRef.current !== null &&
      (shouldShowReconnectToast || shouldShowOfflineToast || shouldShowExhaustedToast)
    ) {
      window.clearTimeout(toastResetTimerRef.current);
      toastResetTimerRef.current = null;
    }

    if (shouldShowReconnectToast || shouldShowOfflineToast || shouldShowExhaustedToast) {
      const toastPayload = shouldShowOfflineToast
        ? stackedThreadToast({
            data: {
              hideCopyButton: true,
            },
            description: describeOfflineToast(),
            timeout: 0,
            title: "Offline",
            type: "warning",
          })
        : shouldShowExhaustedToast
          ? stackedThreadToast({
              actionProps: {
                children: "Retry",
                onClick: triggerManualReconnect,
              },
              data: {
                hideCopyButton: true,
              },
              description: describeExhaustedToast(),
              timeout: 0,
              title: buildReconnectTitle(status),
              type: "error",
            })
          : stackedThreadToast({
              actionProps: {
                children: "Retry now",
                onClick: triggerManualReconnect,
              },
              data: {
                hideCopyButton: true,
              },
              description:
                status.nextRetryAt === null
                  ? `Reconnecting... ${formatReconnectAttemptLabel(status)}`
                  : `Reconnecting in ${formatRetryCountdown(status.nextRetryAt, nowMs)}... ${formatReconnectAttemptLabel(status)}`,
              timeout: 0,
              title: buildReconnectTitle(status),
              type: "loading",
            });

      if (toastIdRef.current) {
        toastManager.update(toastIdRef.current, toastPayload);
      } else {
        toastIdRef.current = toastManager.add(toastPayload);
      }
    } else if (toastIdRef.current) {
      toastManager.close(toastIdRef.current);
      toastIdRef.current = null;
    }

    if (
      uiState === "connected" &&
      announcedLossRef.current &&
      (previousUiState === "offline" || previousUiState === "reconnecting") &&
      previousDisconnectedAt !== null
    ) {
      const successToast = {
        description: describeRecoveredToast(previousDisconnectedAt, status.connectedAt),
        title: buildRecoveredTitle(status),
        type: "success" as const,
        timeout: 0,
        data: {
          dismissAfterVisibleMs: 8_000,
          hideCopyButton: true,
        },
      };

      if (toastIdRef.current) {
        toastManager.update(toastIdRef.current, successToast);
      } else {
        toastIdRef.current = toastManager.add(successToast);
      }

      toastResetTimerRef.current = window.setTimeout(() => {
        toastIdRef.current = null;
        toastResetTimerRef.current = null;
      }, 8_250);
    }

    announcedLossRef.current =
      uiState === "connected"
        ? false
        : announcedLossRef.current ||
          shouldShowReconnectToast ||
          shouldShowOfflineToast ||
          shouldShowExhaustedToast;
    previousUiStateRef.current = uiState;
    previousDisconnectedAtRef.current = status.disconnectedAt;
  }, [noticeArmed, nowMs, status]);

  useEffect(() => {
    return () => {
      if (toastResetTimerRef.current !== null) {
        window.clearTimeout(toastResetTimerRef.current);
      }
    };
  }, []);

  return null;
}

export function SlowRpcAckToastCoordinator() {
  const slowRequests = useSlowRpcAckRequests();
  const status = useWsConnectionStatus();
  const toastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);

  useEffect(() => {
    if (getWsConnectionUiState(status) !== "connected") {
      if (toastIdRef.current) {
        toastManager.close(toastIdRef.current);
        toastIdRef.current = null;
      }
      return;
    }

    if (slowRequests.length === 0) {
      if (toastIdRef.current) {
        toastManager.close(toastIdRef.current);
        toastIdRef.current = null;
      }
      return;
    }

    const nextToast = {
      data: {
        expandableContent: <SlowRpcAckRequestDetails requests={slowRequests} />,
        expandableDescriptionTrigger: true,
        expandableLabels: { collapse: "Hide requests", expand: "Show requests" },
      },
      description: describeSlowRpcAckToast(slowRequests),
      timeout: 0,
      title: "Some requests are slow",
      type: "warning" as const,
    };

    if (toastIdRef.current) {
      toastManager.update(toastIdRef.current, nextToast);
    } else {
      toastIdRef.current = toastManager.add(nextToast);
    }
  }, [slowRequests, status]);

  return null;
}

export function WebSocketConnectionSurface({ children }: { readonly children: ReactNode }) {
  return children;
}
