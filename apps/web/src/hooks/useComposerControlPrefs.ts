/**
 * Client-side visibility prefs for the composer's footer controls.
 *
 * The footer only has so much room, and which controls earn a permanent seat
 * there is a matter of habit: someone who never leaves "full access" or never
 * uses plan mode is paying width for a button they don't press. These prefs
 * hide those controls without changing what they do — a hidden control keeps
 * its last value, and the compact overflow menu hides the same sections, so
 * the footer and the menu never disagree about what exists.
 *
 * Purely local presentation (like the smooth-caret pref in `useTheme`), so it
 * lives in `localStorage` rather than the server-persisted settings.
 */
import { useCallback, useSyncExternalStore } from "react";

function hasStorage(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}

/**
 * Builds a boolean pref that defaults to `true`. Stored only when turned off,
 * so an untouched install carries no key and picks up the default.
 */
function createHiddenWhenOffPreference(storageKey: string) {
  let listeners: Array<() => void> = [];

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const read = (): boolean => {
    if (!hasStorage()) return true;
    return localStorage.getItem(storageKey) !== "off";
  };

  const subscribe = (listener: () => void): (() => void) => {
    if (typeof window === "undefined") return () => {};
    listeners.push(listener);
    const handleStorage = (event: StorageEvent) => {
      if (event.key === storageKey) emit();
    };
    window.addEventListener("storage", handleStorage);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
      window.removeEventListener("storage", handleStorage);
    };
  };

  const getServerSnapshot = () => true;

  return function usePreference() {
    const enabled = useSyncExternalStore(subscribe, read, getServerSnapshot);
    const setEnabled = useCallback((next: boolean) => {
      if (!hasStorage()) return;
      if (next) {
        localStorage.removeItem(storageKey);
      } else {
        localStorage.setItem(storageKey, "off");
      }
      emit();
    }, []);
    return [enabled, setEnabled] as const;
  };
}

/** Shows the Build/Plan mode toggle in the composer footer. */
export const useShowInteractionModeControl = createHiddenWhenOffPreference(
  "t3code:composer-show-interaction-mode",
);

/** Shows the Supervised / Auto-accept edits / Full access picker. */
export const useShowRuntimeModeControl = createHiddenWhenOffPreference(
  "t3code:composer-show-runtime-mode",
);
