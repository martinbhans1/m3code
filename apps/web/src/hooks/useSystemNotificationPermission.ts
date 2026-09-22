import { useCallback, useState } from "react";

import {
  getSystemNotificationPermission,
  requestSystemNotificationPermission,
  type SystemNotificationPermission,
} from "../lib/systemNotifications";

/**
 * Current OS notification permission, plus a way to ask for it.
 *
 * The permission is read once per mount rather than watched: it only ever
 * changes in response to the prompt this hook triggers, or to a browser
 * setting the user changes outside the app and then comes back from.
 */
export function useSystemNotificationPermission(): {
  readonly permission: SystemNotificationPermission;
  readonly requestPermission: () => Promise<SystemNotificationPermission>;
} {
  const [permission, setPermission] = useState<SystemNotificationPermission>(
    getSystemNotificationPermission,
  );

  const requestPermission = useCallback(async () => {
    const next = await requestSystemNotificationPermission();
    setPermission(next);
    return next;
  }, []);

  return { permission, requestPermission };
}
