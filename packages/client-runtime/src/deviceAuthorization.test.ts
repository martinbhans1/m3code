import { describe, expect, it } from "vite-plus/test";
import {
  createDeviceCredentialRenewer,
  type RenewableDeviceCredential,
} from "./deviceAuthorization.ts";

describe("device credential renewal", () => {
  it("coalesces concurrent refresh and persists the operation before transmission", async () => {
    let stored: RenewableDeviceCredential = {
      refreshToken: "old",
      accessToken: "expired",
      accessExpiresAt: 0,
    };
    let calls = 0;
    const manager = createDeviceCredentialRenewer({
      now: () => 1,
      requestId: () => "one-operation",
      load: async () => stored,
      save: async (value) => {
        stored = value;
      },
      refresh: async (_, id) => {
        calls++;
        expect(stored.pendingRequestId).toBe(id);
        return { refreshToken: "rotated", accessToken: "new", accessExpiresAt: 900_001 };
      },
    });
    const result = await Promise.all([manager.renew(), manager.renew()]);
    expect(calls).toBe(1);
    expect(result[0]).toEqual(result[1]);
    expect(stored.pendingRequestId).toBeUndefined();
    await manager.renew();
    expect(calls).toBe(1);
  });

  it("retries the same persisted operation after losing the response and restarting", async () => {
    let stored: RenewableDeviceCredential = {
      refreshToken: "old",
      accessToken: "expired",
      accessExpiresAt: 0,
    };
    const fixture = {
      load: async () => stored,
      save: async (v: RenewableDeviceCredential) => {
        stored = v;
      },
      now: () => 1,
      requestId: () => "original-operation",
    };
    const failed = createDeviceCredentialRenewer({
      ...fixture,
      refresh: async () => {
        throw new Error("connection lost");
      },
    });
    await expect(failed.renew()).rejects.toThrow("connection lost");
    const restarted = createDeviceCredentialRenewer({
      ...fixture,
      requestId: () => "incorrect-new-operation",
      refresh: async (_, id) => {
        expect(id).toBe("original-operation");
        return { refreshToken: "new", accessToken: "new", accessExpiresAt: 900_001 };
      },
    });
    await restarted.renew();
    expect(stored.refreshToken).toBe("new");
  });

  it("does not persist a late rotation after logout", async () => {
    let stored: RenewableDeviceCredential = {
      refreshToken: "old",
      accessToken: "expired",
      accessExpiresAt: 0,
    };
    let finish!: (v: RenewableDeviceCredential) => void;
    let started!: () => void;
    const transmitting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const manager = createDeviceCredentialRenewer({
      requestId: () => "operation",
      load: async () => stored,
      save: async (v) => {
        stored = v;
      },
      refresh: () => {
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const renewing = manager.renew();
    await transmitting;
    const stopping = manager.stop();
    finish({ refreshToken: "new", accessToken: "new", accessExpiresAt: 900_000 });
    await expect(renewing).rejects.toThrow("removed");
    await stopping;
    expect(stored.refreshToken).toBe("old");
  });
});
