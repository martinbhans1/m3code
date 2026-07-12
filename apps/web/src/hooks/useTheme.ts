import { useCallback, useEffect, useSyncExternalStore } from "react";

export type ThemeBase = "light" | "dark";

export interface ThemeDefinition {
  /** Value stored in localStorage and written to `documentElement.dataset.theme`. */
  readonly id: string;
  /** Human label shown in the settings picker. */
  readonly label: string;
  /** Base mode — drives the `.dark` class and the native window chrome. */
  readonly base: ThemeBase;
  /** Group heading in the picker. */
  readonly group: "Light" | "Dark";
}

/**
 * Registry of selectable palettes. Each non-default palette also needs a token
 * block in apps/web/src/themes.css keyed by the same id. Adding a theme is just:
 * append here + add the CSS block — no component changes required.
 */
export const THEME_DEFINITIONS: readonly ThemeDefinition[] = [
  { id: "light", label: "Light", base: "light", group: "Light" },
  { id: "solarized", label: "Solarized", base: "light", group: "Light" },
  { id: "rose", label: "Rosé", base: "light", group: "Light" },
  { id: "sand", label: "Sand", base: "light", group: "Light" },
  { id: "dark", label: "Dark", base: "dark", group: "Dark" },
  { id: "midnight", label: "Midnight", base: "dark", group: "Dark" },
  { id: "nebula", label: "Nebula", base: "dark", group: "Dark" },
  { id: "glass", label: "Glass", base: "dark", group: "Dark" },
  { id: "nord", label: "Nord", base: "dark", group: "Dark" },
  { id: "forest", label: "Forest", base: "dark", group: "Dark" },
];

const THEME_BY_ID: ReadonlyMap<string, ThemeDefinition> = new Map(
  THEME_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export type ThemeId = (typeof THEME_DEFINITIONS)[number]["id"];
/** A stored preference: an explicit palette id, or "system" to follow the OS. */
export type Theme = "system" | ThemeId;

type ThemeSnapshot = {
  theme: Theme;
  systemDark: boolean;
};

const STORAGE_KEY = "t3code:theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const DEFAULT_THEME_SNAPSHOT: ThemeSnapshot = {
  theme: "system",
  systemDark: false,
};
const THEME_COLOR_META_NAME = "theme-color";
const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`;

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
let lastDesktopTheme: ThemeBase | "system" | null = null;

function emitChange() {
  for (const listener of listeners) listener();
}

function hasThemeStorage() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function getSystemDark() {
  return typeof window !== "undefined" && window.matchMedia(MEDIA_QUERY).matches;
}

export function isValidTheme(value: unknown): value is Theme {
  return value === "system" || (typeof value === "string" && THEME_BY_ID.has(value));
}

function getStored(): Theme {
  if (!hasThemeStorage()) return DEFAULT_THEME_SNAPSHOT.theme;
  const raw = localStorage.getItem(STORAGE_KEY);
  return isValidTheme(raw) ? raw : DEFAULT_THEME_SNAPSHOT.theme;
}

/** Resolve a stored preference (which may be "system") to a concrete palette id. */
function resolveThemeId(theme: Theme, systemDark: boolean): ThemeId {
  if (theme === "system") return systemDark ? "dark" : "light";
  return theme;
}

function resolveBase(theme: Theme, systemDark: boolean): ThemeBase {
  return THEME_BY_ID.get(resolveThemeId(theme, systemDark))?.base ?? "light";
}

function ensureThemeColorMetaTag(): HTMLMetaElement {
  let element = document.querySelector<HTMLMetaElement>(DYNAMIC_THEME_COLOR_SELECTOR);
  if (element) {
    return element;
  }

  element = document.createElement("meta");
  element.name = THEME_COLOR_META_NAME;
  element.setAttribute("data-dynamic-theme-color", "true");
  document.head.append(element);
  return element;
}

function normalizeThemeColor(value: string | null | undefined): string | null {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return null;
  }

  return value?.trim() ?? null;
}

function resolveBrowserChromeSurface(): HTMLElement {
  return (
    document.querySelector<HTMLElement>("main[data-slot='sidebar-inset']") ??
    document.querySelector<HTMLElement>("[data-slot='sidebar-inner']") ??
    document.body
  );
}

export function syncBrowserChromeTheme() {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return;
  const surfaceColor = normalizeThemeColor(
    getComputedStyle(resolveBrowserChromeSurface()).backgroundColor,
  );
  const fallbackColor = normalizeThemeColor(getComputedStyle(document.body).backgroundColor);
  const backgroundColor = surfaceColor ?? fallbackColor;
  if (!backgroundColor) return;

  document.documentElement.style.backgroundColor = backgroundColor;
  document.body.style.backgroundColor = backgroundColor;
  ensureThemeColorMetaTag().setAttribute("content", backgroundColor);
}

function applyTheme(theme: Theme, suppressTransitions = false) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }
  const systemDark = getSystemDark();
  const resolvedId = resolveThemeId(theme, systemDark);
  const base = resolveBase(theme, systemDark);
  // Toggle `.dark` from the palette's base so every `dark:` utility keeps
  // resolving, and expose the concrete palette id for themes.css selectors.
  document.documentElement.classList.toggle("dark", base === "dark");
  document.documentElement.dataset.theme = resolvedId;
  syncBrowserChromeTheme();
  // The native window chrome only understands light/dark/system.
  syncDesktopTheme(theme === "system" ? "system" : base);
  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal
    // oxlint-disable-next-line no-unused-expressions
    document.documentElement.offsetHeight;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }
}

function syncDesktopTheme(theme: ThemeBase | "system") {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (!bridge || typeof bridge.setTheme !== "function" || lastDesktopTheme === theme) {
    return;
  }

  lastDesktopTheme = theme;
  void bridge.setTheme(theme).catch(() => {
    if (lastDesktopTheme === theme) {
      lastDesktopTheme = null;
    }
  });
}

// Apply immediately on module load to prevent flash
if (typeof document !== "undefined" && hasThemeStorage()) {
  applyTheme(getStored());
}

function getSnapshot(): ThemeSnapshot {
  if (!hasThemeStorage()) return DEFAULT_THEME_SNAPSHOT;
  const theme = getStored();
  const systemDark = theme === "system" ? getSystemDark() : false;

  if (lastSnapshot && lastSnapshot.theme === theme && lastSnapshot.systemDark === systemDark) {
    return lastSnapshot;
  }

  lastSnapshot = { theme, systemDark };
  return lastSnapshot;
}

function getServerSnapshot() {
  return DEFAULT_THEME_SNAPSHOT;
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.push(listener);

  // Listen for system preference changes
  const mq = window.matchMedia(MEDIA_QUERY);
  const handleChange = () => {
    if (getStored() === "system") applyTheme("system", true);
    emitChange();
  };
  mq.addEventListener("change", handleChange);

  // Listen for storage changes from other tabs
  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      applyTheme(getStored(), true);
      emitChange();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    mq.removeEventListener("change", handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const theme = snapshot.theme;

  const resolvedTheme: ThemeBase = resolveBase(theme, snapshot.systemDark);

  const setTheme = useCallback((next: Theme) => {
    if (!hasThemeStorage()) return;
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next, true);
    emitChange();
  }, []);

  // Keep DOM in sync on mount/change
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return { theme, setTheme, resolvedTheme } as const;
}

// ── Ambient environment axis ──────────────────────────────────────────────
// Orthogonal to the color palette: the palette (above) picks colors, the
// environment picks how lively the background is. Persisted the same way — a
// localStorage key + a `data-environment` attribute that themes.css reads.

export interface EnvironmentDefinition {
  /** Value stored in localStorage and written to `documentElement.dataset.environment`. */
  readonly id: string;
  /** Human label shown in the settings picker. */
  readonly label: string;
  /** One-line description for the picker. */
  readonly description: string;
}

export const ENVIRONMENT_DEFINITIONS: readonly EnvironmentDefinition[] = [
  { id: "plain", label: "Plain", description: "A flat, professional surface — no motion." },
  { id: "aurora", label: "Aurora", description: "A soft color gradient that slowly drifts." },
  { id: "cosmos", label: "Cosmos", description: "Drifting gradient with a subtle starfield." },
];

const ENVIRONMENT_BY_ID: ReadonlyMap<string, EnvironmentDefinition> = new Map(
  ENVIRONMENT_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export type EnvironmentId = (typeof ENVIRONMENT_DEFINITIONS)[number]["id"];

const ENVIRONMENT_STORAGE_KEY = "t3code:environment";
const DEFAULT_ENVIRONMENT: EnvironmentId = "cosmos";

let environmentListeners: Array<() => void> = [];

function emitEnvironmentChange() {
  for (const listener of environmentListeners) listener();
}

export function isValidEnvironment(value: unknown): value is EnvironmentId {
  return typeof value === "string" && ENVIRONMENT_BY_ID.has(value);
}

function getStoredEnvironment(): EnvironmentId {
  if (!hasThemeStorage()) return DEFAULT_ENVIRONMENT;
  const raw = localStorage.getItem(ENVIRONMENT_STORAGE_KEY);
  return isValidEnvironment(raw) ? raw : DEFAULT_ENVIRONMENT;
}

function applyEnvironment(environment: EnvironmentId) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.environment = environment;
}

// Apply immediately on module load to prevent a flash of the wrong ambient.
if (typeof document !== "undefined" && hasThemeStorage()) {
  applyEnvironment(getStoredEnvironment());
}

function subscribeEnvironment(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  environmentListeners.push(listener);

  const handleStorage = (event: StorageEvent) => {
    if (event.key === ENVIRONMENT_STORAGE_KEY) {
      applyEnvironment(getStoredEnvironment());
      emitEnvironmentChange();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    environmentListeners = environmentListeners.filter((l) => l !== listener);
    window.removeEventListener("storage", handleStorage);
  };
}

function getEnvironmentSnapshot(): EnvironmentId {
  return getStoredEnvironment();
}

function getEnvironmentServerSnapshot(): EnvironmentId {
  return DEFAULT_ENVIRONMENT;
}

export function useEnvironment() {
  const environment = useSyncExternalStore(
    subscribeEnvironment,
    getEnvironmentSnapshot,
    getEnvironmentServerSnapshot,
  );

  const setEnvironment = useCallback((next: EnvironmentId) => {
    if (!hasThemeStorage()) return;
    localStorage.setItem(ENVIRONMENT_STORAGE_KEY, next);
    applyEnvironment(next);
    emitEnvironmentChange();
  }, []);

  return { environment, setEnvironment, definitions: ENVIRONMENT_DEFINITIONS } as const;
}

// ── Custom chrome tint ─────────────────────────────────────────────────────
// Optional user-chosen hue for the sidebar + header surface (and the ambient
// glow). Stored as a `#rrggbb` string, or "" / null for "use the theme default".
// Applied as `--chrome-tint` + a `data-chrome-tint="on"` flag that themes.css
// keys off — see the [data-chrome-tint] blocks.

const CHROME_TINT_STORAGE_KEY = "t3code:chrome-tint";
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

let chromeTintListeners: Array<() => void> = [];

function emitChromeTintChange() {
  for (const listener of chromeTintListeners) listener();
}

export function normalizeChromeTint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return HEX_COLOR_RE.test(trimmed) ? trimmed : null;
}

function getStoredChromeTint(): string | null {
  if (!hasThemeStorage()) return null;
  return normalizeChromeTint(localStorage.getItem(CHROME_TINT_STORAGE_KEY));
}

function applyChromeTint(tint: string | null) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (tint) {
    root.dataset.chromeTint = "on";
    root.style.setProperty("--chrome-tint", tint);
  } else {
    delete root.dataset.chromeTint;
    root.style.removeProperty("--chrome-tint");
  }
}

// Apply immediately on module load to prevent a flash of the untinted chrome.
if (typeof document !== "undefined" && hasThemeStorage()) {
  applyChromeTint(getStoredChromeTint());
}

function subscribeChromeTint(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  chromeTintListeners.push(listener);

  const handleStorage = (event: StorageEvent) => {
    if (event.key === CHROME_TINT_STORAGE_KEY) {
      applyChromeTint(getStoredChromeTint());
      emitChromeTintChange();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    chromeTintListeners = chromeTintListeners.filter((l) => l !== listener);
    window.removeEventListener("storage", handleStorage);
  };
}

function getChromeTintSnapshot(): string | null {
  return getStoredChromeTint();
}

function getChromeTintServerSnapshot(): string | null {
  return null;
}

export function useChromeTint() {
  const chromeTint = useSyncExternalStore(
    subscribeChromeTint,
    getChromeTintSnapshot,
    getChromeTintServerSnapshot,
  );

  const setChromeTint = useCallback((next: string | null) => {
    if (!hasThemeStorage()) return;
    const normalized = normalizeChromeTint(next);
    if (normalized) {
      localStorage.setItem(CHROME_TINT_STORAGE_KEY, normalized);
    } else {
      localStorage.removeItem(CHROME_TINT_STORAGE_KEY);
    }
    applyChromeTint(normalized);
    emitChromeTintChange();
  }, []);

  return { chromeTint, setChromeTint } as const;
}

// ── Smooth caret ───────────────────────────────────────────────────────────
// Optional preference that swaps the native text caret in the chat composer
// for a custom overlay that glides between positions. Purely client-side and
// visual, so it lives with the other appearance prefs rather than in the
// server-persisted settings. Stored as a boolean flag + a `data-smooth-caret`
// attribute that the composer's caret plugin keys off.

const SMOOTH_CARET_STORAGE_KEY = "t3code:smooth-caret";
const DEFAULT_SMOOTH_CARET = false;

let smoothCaretListeners: Array<() => void> = [];

function emitSmoothCaretChange() {
  for (const listener of smoothCaretListeners) listener();
}

function getStoredSmoothCaret(): boolean {
  if (!hasThemeStorage()) return DEFAULT_SMOOTH_CARET;
  return localStorage.getItem(SMOOTH_CARET_STORAGE_KEY) === "on";
}

function applySmoothCaret(enabled: boolean) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (enabled) {
    root.dataset.smoothCaret = "on";
  } else {
    delete root.dataset.smoothCaret;
  }
}

// Apply immediately on module load so the caret style is correct before paint.
if (typeof document !== "undefined" && hasThemeStorage()) {
  applySmoothCaret(getStoredSmoothCaret());
}

function subscribeSmoothCaret(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  smoothCaretListeners.push(listener);

  const handleStorage = (event: StorageEvent) => {
    if (event.key === SMOOTH_CARET_STORAGE_KEY) {
      applySmoothCaret(getStoredSmoothCaret());
      emitSmoothCaretChange();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    smoothCaretListeners = smoothCaretListeners.filter((l) => l !== listener);
    window.removeEventListener("storage", handleStorage);
  };
}

function getSmoothCaretSnapshot(): boolean {
  return getStoredSmoothCaret();
}

function getSmoothCaretServerSnapshot(): boolean {
  return DEFAULT_SMOOTH_CARET;
}

export function useSmoothCaret() {
  const smoothCaret = useSyncExternalStore(
    subscribeSmoothCaret,
    getSmoothCaretSnapshot,
    getSmoothCaretServerSnapshot,
  );

  const setSmoothCaret = useCallback((next: boolean) => {
    if (!hasThemeStorage()) return;
    if (next) {
      localStorage.setItem(SMOOTH_CARET_STORAGE_KEY, "on");
    } else {
      localStorage.removeItem(SMOOTH_CARET_STORAGE_KEY);
    }
    applySmoothCaret(next);
    emitSmoothCaretChange();
  }, []);

  return { smoothCaret, setSmoothCaret } as const;
}
