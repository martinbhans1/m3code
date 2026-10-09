import { createHash, createHmac, randomBytes } from "node:crypto";
import { AuthSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SessionStore from "./SessionStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const ACCESS_TTL = Duration.minutes(15);
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const invalid = () =>
  new SessionStore.SessionCredentialInvalidError({
    message: "Device credential invalid or revoked.",
  });

type DeviceRow = {
  sessionId: string;
  proofKey: string;
  refreshHash: string;
  revokedAt: string | null;
};
type HistoryRow = { sessionId: string; requestId: string; nextHash: string };
type DeviceSession = SessionStore.IssuedSession & { readonly refreshToken: string };

export class DurableDeviceAuthorization extends Context.Service<
  DurableDeviceAuthorization,
  {
    readonly issue: (
      input: NonNullable<Parameters<SessionStore.SessionStoreShape["issue"]>[0]> & {
        proofKeyThumbprint: string;
      },
    ) => Effect.Effect<DeviceSession, SessionStore.SessionCredentialInternalError>;
    readonly refresh: (
      token: string,
      requestId: string,
      proofKey: string,
    ) => Effect.Effect<DeviceSession, SessionStore.SessionCredentialError>;
    readonly logout: (
      token: string,
      proofKey: string,
    ) => Effect.Effect<boolean, SessionStore.SessionCredentialError>;
  }
>()("t3/auth/DurableDeviceAuthorization") {}

export const layer = Layer.effect(
  DurableDeviceAuthorization,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessions = yield* SessionStore.SessionStore;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const rotationSecret = yield* secrets.getOrCreateRandom("device-refresh-rotation-key", 32);
    const nextToken = (oldHash: string, requestId: string) =>
      createHmac("sha256", rotationSecret).update(`${oldHash}:${requestId}`).digest("base64url");
    const internal = (cause: unknown) =>
      cause instanceof SessionStore.SessionCredentialInvalidError ||
      cause instanceof SessionStore.SessionCredentialInternalError
        ? cause
        : new SessionStore.SessionCredentialInternalError({
            message: "Device authorization unavailable.",
            cause,
          });
    const findDevice = (sessionId: string) =>
      sql<DeviceRow>`SELECT d.session_id AS "sessionId", d.proof_key_thumbprint AS "proofKey", d.refresh_hash AS "refreshHash", s.revoked_at AS "revokedAt" FROM auth_devices d JOIN auth_sessions s ON s.session_id = d.session_id WHERE d.session_id = ${sessionId}`;
    const lookup = Effect.fn("DeviceAuthorization.lookup")(function* (token: string) {
      const tokenHash = hash(token);
      const current =
        yield* sql<DeviceRow>`SELECT d.session_id AS "sessionId", d.proof_key_thumbprint AS "proofKey", d.refresh_hash AS "refreshHash", s.revoked_at AS "revokedAt" FROM auth_devices d JOIN auth_sessions s ON s.session_id = d.session_id WHERE d.refresh_hash = ${tokenHash}`;
      if (current[0]) return { device: current[0], tokenHash, history: undefined };
      const history =
        yield* sql<HistoryRow>`SELECT session_id AS "sessionId", request_id AS "requestId", next_hash AS "nextHash" FROM auth_device_refresh_history WHERE refresh_hash = ${tokenHash}`;
      const device = history[0] ? (yield* findDevice(history[0].sessionId))[0] : undefined;
      if (!device) return yield* invalid();
      return { device, tokenHash, history: history[0] };
    });
    return DurableDeviceAuthorization.of({
      issue: Effect.fn("DeviceAuthorization.issue")(
        function* (input) {
          const refreshToken = randomBytes(32).toString("base64url");
          const session = yield* sql.withTransaction(
            Effect.gen(function* () {
              const { proofKeyThumbprint: _, ...accessInput } = input;
              const issued = yield* sessions.issue({
                ...accessInput,
                method: "bearer-access-token",
                ttl: ACCESS_TTL,
              });
              yield* sql`INSERT INTO auth_devices (session_id, proof_key_thumbprint, refresh_hash) VALUES (${issued.sessionId}, ${input.proofKeyThumbprint}, ${hash(refreshToken)})`;
              return issued;
            }),
          );
          return { ...session, refreshToken };
        },
        Effect.mapError(
          (cause) =>
            new SessionStore.SessionCredentialInternalError({
              message: "Device authorization issuance failed.",
              cause,
            }),
        ),
      ),
      refresh: Effect.fn("DeviceAuthorization.refresh")(function* (token, requestId, proofKey) {
        // Serialize lookup, rotation and reissuance in SQLite, including across server processes.
        // Return replay as data so revocation commits instead of rolling back with an error.
        const outcome = yield* sql.withTransaction(
          Effect.gen(function* () {
            // Acquire the SQLite write lock before reading a snapshot, avoiding deferred
            // transaction races between independent backend processes.
            yield* sql`UPDATE auth_devices SET refresh_hash = refresh_hash WHERE refresh_hash = ${hash(token)}`;
            const { device, tokenHash, history } = yield* lookup(token);
            if (device.revokedAt !== null || device.proofKey !== proofKey) return yield* invalid();
            if (
              history &&
              (history.requestId !== requestId || history.nextHash !== device.refreshHash)
            ) {
              yield* sessions.revoke(AuthSessionId.make(device.sessionId));
              return { replay: true as const, sessionId: AuthSessionId.make(device.sessionId) };
            }
            const refreshToken = nextToken(tokenHash, requestId);
            if (!history) {
              yield* sql`INSERT INTO auth_device_refresh_history (refresh_hash, session_id, request_id, next_hash) VALUES (${tokenHash}, ${device.sessionId}, ${requestId}, ${hash(refreshToken)})`;
              yield* sql`UPDATE auth_devices SET refresh_hash = ${hash(refreshToken)} WHERE session_id = ${device.sessionId}`;
            }
            const session = yield* sessions.renewDeviceAccess(
              AuthSessionId.make(device.sessionId),
              proofKey,
              ACCESS_TTL,
            );
            return { replay: false as const, session: { ...session, refreshToken } };
          }),
        );
        if (outcome.replay) {
          // Notify connected clients through the existing revocation stream.
          // The revocation and notification were committed by the transaction above.
          return yield* invalid();
        }
        return outcome.session;
      }, Effect.mapError(internal)),
      logout: Effect.fn("DeviceAuthorization.logout")(function* (token, proofKey) {
        const { device } = yield* lookup(token);
        if (device.proofKey !== proofKey) return yield* invalid();
        return yield* sessions.revoke(AuthSessionId.make(device.sessionId));
      }, Effect.mapError(internal)),
    });
  }),
);
