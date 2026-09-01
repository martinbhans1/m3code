/**
 * The desktop app's identity as Windows understands it.
 *
 * A toast is posted under the AppUserModelID the process sets, and Windows
 * resolves the name and icon it shows from the Start Menu shortcut carrying
 * that same id — the one the installer writes from electron-builder's `appId`.
 * When the two strings disagree the lookup fails and the notification is
 * attributed to the raw Electron binary instead of the app, so the packaged
 * `appId` and the id the running app sets must come from here rather than
 * being spelled out separately in the build script and the runtime.
 */
export const DESKTOP_APP_ID = "com.m3tools.m3code";

/**
 * Development runs deliberately claim a separate identity so their windows,
 * jump lists and notifications never merge with the installed app's.
 */
export const DESKTOP_DEVELOPMENT_APP_ID = `${DESKTOP_APP_ID}.dev`;
