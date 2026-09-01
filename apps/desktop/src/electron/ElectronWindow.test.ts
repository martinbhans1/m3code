import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

const { appFocusMock, getAllWindowsMock } = vi.hoisted(() => ({
  appFocusMock: vi.fn(),
  getAllWindowsMock: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    focus: appFocusMock,
  },
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
}));

import * as ElectronWindow from "./ElectronWindow.ts";

function makeBrowserWindow(input: { readonly destroyed: boolean }) {
  return {
    isDestroyed: vi.fn(() => input.destroyed),
  } as unknown as Electron.BrowserWindow;
}

function makeRevealWindow() {
  const calls: string[] = [];
  let alwaysOnTop = false;
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push("restore"),
    isVisible: () => false,
    show: () => calls.push("show"),
    isAlwaysOnTop: () => alwaysOnTop,
    setAlwaysOnTop: (value: boolean) => {
      alwaysOnTop = value;
      calls.push(`alwaysOnTop:${value}`);
    },
    moveTop: () => calls.push("moveTop"),
    focus: () => calls.push("focus"),
  } as unknown as Electron.BrowserWindow;
  return { window, calls };
}

describe("ElectronWindow", () => {
  beforeEach(() => {
    appFocusMock.mockReset();
    getAllWindowsMock.mockReset();
  });

  it.effect("skips windows destroyed before appearance sync runs", () =>
    Effect.gen(function* () {
      const liveWindow = makeBrowserWindow({ destroyed: false });
      const destroyedWindow = makeBrowserWindow({ destroyed: true });
      getAllWindowsMock.mockReturnValue([destroyedWindow, liveWindow]);

      const syncedWindows: Electron.BrowserWindow[] = [];
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* electronWindow.syncAllAppearance((window) =>
        Effect.sync(() => {
          syncedWindows.push(window);
        }),
      );

      assert.deepEqual(syncedWindows, [liveWindow]);
    }).pipe(Effect.provide(ElectronWindow.layer)),
  );

  it.effect("raises a background window on Windows instead of only asking for focus", () =>
    Effect.gen(function* () {
      const { window, calls } = makeRevealWindow();
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      yield* electronWindow.reveal(window);

      // Windows refuses foreground to a background process, so the window has
      // to be pinned on top to actually come forward — and unpinned again so
      // it does not stay there.
      assert.deepEqual(calls, [
        "restore",
        "show",
        "alwaysOnTop:true",
        "moveTop",
        "focus",
        "alwaysOnTop:false",
      ]);
      assert.equal(appFocusMock.mock.calls.length, 0);
    }).pipe(
      Effect.provide(ElectronWindow.layer),
      Effect.provideService(HostProcessPlatform, "win32"),
    ),
  );

  it.effect("keeps a window pinned on top pinned after revealing it", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const window = {
        isDestroyed: () => false,
        isMinimized: () => false,
        isVisible: () => true,
        isAlwaysOnTop: () => true,
        setAlwaysOnTop: (value: boolean) => calls.push(`alwaysOnTop:${value}`),
        moveTop: () => calls.push("moveTop"),
        focus: () => calls.push("focus"),
      } as unknown as Electron.BrowserWindow;
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      yield* electronWindow.reveal(window);

      assert.deepEqual(calls, ["alwaysOnTop:true", "moveTop", "focus", "alwaysOnTop:true"]);
    }).pipe(
      Effect.provide(ElectronWindow.layer),
      Effect.provideService(HostProcessPlatform, "win32"),
    ),
  );

  it.effect("steals focus through the app on macOS rather than reordering the window", () =>
    Effect.gen(function* () {
      const { window, calls } = makeRevealWindow();
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      yield* electronWindow.reveal(window);

      assert.deepEqual(calls, ["restore", "show", "focus"]);
      assert.deepEqual(appFocusMock.mock.calls, [[{ steal: true }]]);
    }).pipe(
      Effect.provide(ElectronWindow.layer),
      Effect.provideService(HostProcessPlatform, "darwin"),
    ),
  );
});
