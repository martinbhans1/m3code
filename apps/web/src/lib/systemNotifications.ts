/**
 * OS-level notification delivery.
 *
 * The renderer owns this rather than the Electron main process: the same code
 * then covers the desktop app and a browser tab pointed at a server, and
 * Electron grants the Notification permission to its own renderer without a
 * prompt. The one thing the renderer genuinely cannot do is raise a background
 * or minimized window, which is why activating a notification goes back
 * through the desktop bridge.
 */

export type SystemNotificationPermission = "unsupported" | "default" | "granted" | "denied";

type NotificationConstructor = typeof Notification;

function notificationApi(): NotificationConstructor | null {
  if (typeof window === "undefined") return null;
  const api = (window as { Notification?: NotificationConstructor }).Notification;
  return typeof api === "function" ? api : null;
}

export function getSystemNotificationPermission(): SystemNotificationPermission {
  const api = notificationApi();
  if (api === null) return "unsupported";
  const permission = api.permission;
  return permission === "granted" || permission === "denied" ? permission : "default";
}

export async function requestSystemNotificationPermission(): Promise<SystemNotificationPermission> {
  const api = notificationApi();
  if (api === null) return "unsupported";
  if (api.permission === "granted" || api.permission === "denied") {
    return api.permission;
  }

  try {
    await api.requestPermission();
  } catch {
    // Older browsers only expose the callback form; the permission the user
    // chose is still readable from the API afterwards.
  }
  return getSystemNotificationPermission();
}

// A notification that nothing references can be garbage collected, which on
// some platforms closes it before it has been read. Holding them until they
// close or are clicked keeps the toast alive for its natural lifetime.
const liveNotifications = new Set<Notification>();

export interface SystemNotificationInput {
  /** Stable per-subject key, so a newer toast replaces its own stale one. */
  readonly tag: string;
  readonly title: string;
  readonly body: string;
  readonly onActivate: () => void;
}

/** Returns whether the notification was handed to the OS. */
export function showSystemNotification(input: SystemNotificationInput): boolean {
  const api = notificationApi();
  if (api === null || api.permission !== "granted") return false;

  let notification: Notification;
  try {
    notification = new api(input.title, { body: input.body, tag: input.tag });
  } catch {
    return false;
  }

  liveNotifications.add(notification);
  const release = () => {
    liveNotifications.delete(notification);
  };
  notification.addEventListener("close", release);
  notification.addEventListener("error", release);
  notification.addEventListener("click", () => {
    release();
    notification.close();
    input.onActivate();
  });
  return true;
}

/**
 * Bring the app to the front. Falls back to `window.focus()` in the browser,
 * where raising a background tab is up to the user agent.
 */
export function focusAppWindow(): void {
  const focusWindow = typeof window === "undefined" ? undefined : window.desktopBridge?.focusWindow;
  if (focusWindow) {
    void focusWindow().catch(() => {
      // A window that refuses to raise still leaves the in-app navigation to
      // the thread, which is the part that matters.
    });
    return;
  }
  window.focus();
}
