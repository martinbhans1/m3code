import { EnvironmentId } from "@t3tools/contracts";
import {
  bootstrapRemoteBearerSession,
  exchangeRemoteDpopAccessToken,
  ManagedRelayDpopSigner,
  remoteEndpointUrl,
  fetchRemoteEnvironmentDescriptor,
} from "@t3tools/client-runtime";
import { resolveRemotePairingTarget, stripPairingTokenFromUrl } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import { mobileAuthClientMetadata } from "./authClientMetadata";
import { mobileRuntime } from "./runtime";

export { mobileAuthClientMetadata } from "./authClientMetadata";

export interface RemoteConnectionInput {
  readonly pairingUrl: string;
}

export interface SavedRemoteConnection {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly pairingUrl: string;
  readonly displayUrl: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearerToken: string | null;
  readonly deviceRefreshToken?: string;
  readonly deviceRefreshRequestId?: string;
  readonly accessExpiresAt?: number;
  readonly authenticationMethod?: "bearer" | "dpop";
  readonly dpopAccessToken?: string;
  readonly relayManaged?: true;
}

export type RemoteClientConnectionState =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "disconnected";

export function redactPairingCredential(pairingUrl: string): string {
  const trimmed = pairingUrl.trim();
  try {
    return stripPairingTokenFromUrl(new URL(trimmed)).toString();
  } catch {
    return trimmed;
  }
}

export function isRelayManagedConnection(
  connection: Pick<SavedRemoteConnection, "authenticationMethod" | "relayManaged">,
): boolean {
  return connection.relayManaged === true || connection.authenticationMethod === "dpop";
}

export function toStableSavedRemoteConnection(
  connection: SavedRemoteConnection,
): SavedRemoteConnection {
  if (!isRelayManagedConnection(connection) || !connection.dpopAccessToken) {
    return connection;
  }

  const { dpopAccessToken: _, ...stableConnection } = connection;
  return stableConnection;
}

export async function bootstrapRemoteConnection(
  input: RemoteConnectionInput,
): Promise<SavedRemoteConnection> {
  const target = resolveRemotePairingTarget({
    pairingUrl: input.pairingUrl,
  });

  const { descriptor, bootstrap } = await mobileRuntime.runPromise(
    Effect.gen(function* () {
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: target.httpBaseUrl,
      });
      if (!descriptor.capabilities.durableDeviceAuthorization) {
        const bootstrap = yield* bootstrapRemoteBearerSession({
          httpBaseUrl: target.httpBaseUrl,
          credential: target.credential,
          clientMetadata: mobileAuthClientMetadata(),
        });
        return { descriptor, bootstrap };
      }
      const signer = yield* ManagedRelayDpopSigner;
      const dpopProof = yield* signer.createProof({
        method: "POST",
        url: remoteEndpointUrl(target.httpBaseUrl, "/oauth/token"),
      });
      const bootstrap = yield* exchangeRemoteDpopAccessToken({
        httpBaseUrl: target.httpBaseUrl,
        credential: target.credential,
        clientMetadata: mobileAuthClientMetadata(),
        dpopProof,
        durableDevice: true,
      });
      if (!bootstrap.refresh_token || bootstrap.token_type !== "Bearer")
        return yield* Effect.fail(new Error("Backend did not issue durable device authorization."));
      return { descriptor, bootstrap };
    }),
  );

  return {
    environmentId: descriptor.environmentId,
    environmentLabel: descriptor.label,
    pairingUrl: redactPairingCredential(input.pairingUrl),
    displayUrl: target.httpBaseUrl,
    httpBaseUrl: target.httpBaseUrl,
    wsBaseUrl: target.wsBaseUrl,
    bearerToken: bootstrap.access_token,
    ...(bootstrap.refresh_token
      ? {
          deviceRefreshToken: bootstrap.refresh_token,
          accessExpiresAt: Date.now() + bootstrap.expires_in * 1000,
        }
      : {}),
    authenticationMethod: "bearer",
  };
}
