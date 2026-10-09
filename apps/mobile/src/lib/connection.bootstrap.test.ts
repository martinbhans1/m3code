import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import type { ManagedRelayDpopSigner } from "@t3tools/client-runtime";
import { EnvironmentId } from "@t3tools/contracts";
import { bootstrapRemoteConnection } from "./connection";

const mocks = vi.hoisted(() => ({
  descriptor: vi.fn(),
  bearer: vi.fn(),
  durable: vi.fn(),
  proof: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("@t3tools/client-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime")>();
  return {
    ...actual,
    fetchRemoteEnvironmentDescriptor: mocks.descriptor,
    bootstrapRemoteBearerSession: mocks.bearer,
    exchangeRemoteDpopAccessToken: mocks.durable,
  };
});
vi.mock("./runtime", async () => {
  const effect = await import("effect/Effect");
  const { ManagedRelayDpopSigner } = await import("@t3tools/client-runtime");
  return {
    mobileRuntime: {
      runPromise: (program: Effect.Effect<unknown, unknown, ManagedRelayDpopSigner>) =>
        effect.runPromise(
          effect.provideService(program, ManagedRelayDpopSigner, {
            thumbprint: effect.succeed("fixture-key"),
            createProof: mocks.proof,
          }),
        ),
    },
  };
});

const descriptor = {
  environmentId: EnvironmentId.make("fixture-phone"),
  label: "Fixture",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "test",
  capabilities: { repositoryIdentity: true },
};
const access = {
  access_token: "fixture-access",
  expires_in: 900,
  token_type: "Bearer",
  issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  scope: "orchestration:read",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.proof.mockReturnValue(Effect.succeed("fixture-proof"));
  mocks.bearer.mockReturnValue(Effect.succeed(access));
  mocks.durable.mockReturnValue(Effect.succeed({ ...access, refresh_token: "fixture-refresh" }));
});

describe("phone pairing capability negotiation", () => {
  it("enrolls a durable device and persists renewable credentials", async () => {
    mocks.descriptor.mockReturnValue(
      Effect.succeed({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, durableDeviceAuthorization: true },
      }),
    );
    const result = await bootstrapRemoteConnection({
      pairingUrl: "https://fixture.example/#token=fixture-pairing",
    });
    expect(result.deviceRefreshToken).toBe("fixture-refresh");
    expect(result.bearerToken).toBe("fixture-access");
    expect(result.accessExpiresAt).toBeGreaterThan(0);
    expect(result.pairingUrl).not.toContain("fixture-pairing");
    expect(mocks.proof).toHaveBeenCalledWith({
      method: "POST",
      url: "https://fixture.example/oauth/token",
    });
    expect(mocks.durable).toHaveBeenCalledWith(
      expect.objectContaining({ durableDevice: true, dpopProof: "fixture-proof" }),
    );
    expect(mocks.bearer).not.toHaveBeenCalled();
  });
  it("keeps legacy pairing for a backend without durable-device support", async () => {
    mocks.descriptor.mockReturnValue(Effect.succeed(descriptor));
    const result = await bootstrapRemoteConnection({
      pairingUrl: "https://fixture.example/#token=fixture-pairing",
    });
    expect(result.deviceRefreshToken).toBeUndefined();
    expect(mocks.bearer).toHaveBeenCalledOnce();
    expect(mocks.durable).not.toHaveBeenCalled();
    expect(mocks.proof).not.toHaveBeenCalled();
  });
});
