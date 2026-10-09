import {
  createDeviceCredentialRenewer,
  ManagedRelayDpopSigner,
  refreshRemoteDeviceSession,
  logoutRemoteDeviceSession,
  remoteEndpointUrl,
} from "@t3tools/client-runtime";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import type { SavedRemoteConnection } from "./connection";
import { loadSavedConnections, updateDeviceCredential } from "./storage";
import { mobileRuntime } from "./runtime";

const renewers = new Map<string, ReturnType<typeof createDeviceCredentialRenewer>>();

export async function renewDeviceConnection(
  connection: SavedRemoteConnection,
): Promise<SavedRemoteConnection> {
  if (!connection.deviceRefreshToken) return connection;
  let renewer = renewers.get(connection.environmentId);
  if (!renewer) {
    renewer = createDeviceCredentialRenewer({
      requestId: () =>
        mobileRuntime.runPromise(
          Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
        ),
      load: async () => {
        const stored = (await loadSavedConnections()).find(
          (entry) => entry.environmentId === connection.environmentId,
        );
        return stored?.deviceRefreshToken
          ? {
              refreshToken: stored.deviceRefreshToken,
              accessToken: stored.bearerToken ?? "",
              accessExpiresAt: stored.accessExpiresAt ?? 0,
              ...(stored.deviceRefreshRequestId
                ? { pendingRequestId: stored.deviceRefreshRequestId }
                : {}),
            }
          : null;
      },
      save: async (credential, expectedRefreshToken) => {
        await updateDeviceCredential(connection.environmentId, expectedRefreshToken, {
          bearerToken: credential.accessToken,
          deviceRefreshToken: credential.refreshToken,
          accessExpiresAt: credential.accessExpiresAt,
          ...(credential.pendingRequestId
            ? { deviceRefreshRequestId: credential.pendingRequestId }
            : {}),
        });
      },
      refresh: async (credential, operationId) => {
        try {
          const stored = (await loadSavedConnections()).find(
            (entry) => entry.environmentId === connection.environmentId,
          );
          if (!stored) throw new Error("Device authorization was removed.");
          const result = await mobileRuntime.runPromise(
            Effect.gen(function* () {
              const signer = yield* ManagedRelayDpopSigner;
              const dpopProof = yield* signer.createProof({
                method: "POST",
                url: remoteEndpointUrl(stored.httpBaseUrl, "/api/auth/device/refresh"),
                accessToken: credential.refreshToken,
              });
              return yield* refreshRemoteDeviceSession({
                httpBaseUrl: stored.httpBaseUrl,
                refreshToken: credential.refreshToken,
                requestId: operationId,
                dpopProof,
              });
            }),
          );
          if (!result.refresh_token) throw new Error("Missing device credential.");
          return {
            refreshToken: result.refresh_token,
            accessToken: result.access_token,
            accessExpiresAt: Date.now() + result.expires_in * 1000,
          };
        } catch {
          // Request errors may contain credential-bearing bodies; do not propagate them to UI/logs.
          throw new Error(
            "Could not renew device authorization. Reconnect to retry; pair again if access was revoked.",
          );
        }
      },
    });
    renewers.set(connection.environmentId, renewer);
  }
  await renewer.renew();
  return (
    (await loadSavedConnections()).find(
      (entry) => entry.environmentId === connection.environmentId,
    ) ?? connection
  );
}

export async function logoutDeviceConnection(connection: SavedRemoteConnection): Promise<void> {
  if (!connection.deviceRefreshToken) return;
  await renewers.get(connection.environmentId)?.stop();
  renewers.delete(connection.environmentId);
  const stored =
    (await loadSavedConnections()).find(
      (entry) => entry.environmentId === connection.environmentId,
    ) ?? connection;
  try {
    await mobileRuntime.runPromise(
      Effect.gen(function* () {
        const signer = yield* ManagedRelayDpopSigner;
        const refreshToken = stored.deviceRefreshToken!;
        const dpopProof = yield* signer.createProof({
          method: "POST",
          url: remoteEndpointUrl(stored.httpBaseUrl, "/api/auth/device/logout"),
          accessToken: refreshToken,
        });
        return yield* logoutRemoteDeviceSession({
          httpBaseUrl: stored.httpBaseUrl,
          refreshToken,
          dpopProof,
        });
      }),
    );
  } catch {
    throw new Error(
      "Could not revoke this device. Reconnect and try removing the environment again.",
    );
  }
}
