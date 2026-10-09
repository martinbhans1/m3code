import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItemAsync: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
    setItemAsync: vi.fn((key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    }),
  };
});

vi.mock("expo-secure-store", () => ({
  getItemAsync: mocks.getItemAsync,
  setItemAsync: mocks.setItemAsync,
}));

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
  },
}));

vi.mock("./runtime", () => ({
  mobileRuntime: {
    runPromise: vi.fn(),
  },
}));

import {
  loadSavedConnections,
  saveConnection,
  clearSavedConnection,
  updateDeviceCredential,
} from "./storage";
import { toStableSavedRemoteConnection } from "./connection";

const managedConnection = {
  environmentId: EnvironmentId.make("environment-1"),
  environmentLabel: "Desktop",
  pairingUrl: "https://desktop.example/",
  displayUrl: "https://desktop.example/",
  httpBaseUrl: "https://desktop.example/",
  wsBaseUrl: "wss://desktop.example/",
  bearerToken: null,
  authenticationMethod: "dpop",
  dpopAccessToken: "short-lived-token",
  relayManaged: true,
} as const;

describe("mobile connection storage", () => {
  beforeEach(() => {
    mocks.clear();
    vi.clearAllMocks();
  });

  it("does not lose concurrent credential updates for different environments", async () => {
    const first = {
      ...managedConnection,
      environmentId: EnvironmentId.make("device-one"),
      authenticationMethod: "bearer" as const,
      bearerToken: "short-access-one",
      deviceRefreshToken: "refresh-one",
    };
    const second = {
      ...first,
      environmentId: EnvironmentId.make("device-two"),
      deviceRefreshToken: "refresh-two",
    };
    await Promise.all([saveConnection(first), saveConnection(second)]);
    const saved = await loadSavedConnections();
    expect(saved.map((entry) => entry.deviceRefreshToken)).toEqual(["refresh-one", "refresh-two"]);
  });

  it("cannot overwrite removal or a new pairing with a late refresh response", async () => {
    const first = {
      ...managedConnection,
      authenticationMethod: "bearer" as const,
      bearerToken: "short-access",
      deviceRefreshToken: "old-refresh",
    };
    await saveConnection(first);
    await saveConnection({ ...first, deviceRefreshToken: "new-pairing" });
    await expect(
      updateDeviceCredential(first.environmentId, "old-refresh", {
        bearerToken: "late-access",
        deviceRefreshToken: "late-refresh",
      }),
    ).rejects.toThrow("replaced");
    expect((await loadSavedConnections())[0]?.deviceRefreshToken).toBe("new-pairing");
    await clearSavedConnection(first.environmentId);
    await expect(
      updateDeviceCredential(first.environmentId, "new-pairing", {
        bearerToken: "late-access",
        deviceRefreshToken: "late-refresh",
      }),
    ).rejects.toThrow("removed");
    expect(await loadSavedConnections()).toEqual([]);
  });

  it("persists relay-managed connections without their ephemeral access token", async () => {
    await saveConnection(managedConnection);

    const savedValue = mocks.setItemAsync.mock.calls[0]?.[1];
    expect(savedValue).toBeDefined();
    expect(JSON.parse(savedValue ?? "")).toEqual({
      connections: [toStableSavedRemoteConnection(managedConnection)],
    });
  });

  it("loads relay-managed connection metadata without a cached access token", async () => {
    await saveConnection(managedConnection);

    await expect(loadSavedConnections()).resolves.toEqual([
      toStableSavedRemoteConnection(managedConnection),
    ]);
  });
});
