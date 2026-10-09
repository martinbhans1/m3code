import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { DurableDeviceAuthorization, layer } from "./DurableDeviceAuthorization.ts";

const fixture = layer.pipe(
  Layer.provideMerge(SessionStore.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-device-auth-test-" })),
);
const issueInput = {
  proofKeyThumbprint: "device-key",
  scopes: ["orchestration:read" as const],
  subject: "paired-phone",
};

it.layer(NodeServices.layer)("durable device authorization (isolated SQLite)", (it) => {
  it.effect("expires access after 15 minutes but renews the same device after 60 days", () =>
    Effect.gen(function* () {
      const devices = yield* DurableDeviceAuthorization;
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* devices.issue(issueInput);
      yield* TestClock.adjust(Duration.minutes(15));
      expect((yield* Effect.flip(sessions.verify(issued.token)))._tag).toBe(
        "SessionCredentialInvalidError",
      );
      yield* TestClock.adjust(Duration.days(60));
      expect((yield* sessions.listActive()).map((s) => s.sessionId)).toContain(issued.sessionId);
      const renewed = yield* devices.refresh(issued.refreshToken, "request-one", "device-key");
      expect(renewed.sessionId).toBe(issued.sessionId);
      expect(renewed.refreshToken).not.toBe(issued.refreshToken);
      expect((yield* sessions.verify(renewed.token)).scopes).toEqual(["orchestration:read"]);
      yield* TestClock.adjust(Duration.minutes(15));
      expect((yield* Effect.flip(sessions.verify(renewed.token)))._tag).toBe(
        "SessionCredentialInvalidError",
      );
    }).pipe(Effect.provide(fixture)),
  );

  it.effect(
    "stores only refresh hashes and does not revoke a device for an attacker with the wrong key",
    () =>
      Effect.gen(function* () {
        const devices = yield* DurableDeviceAuthorization;
        const sql = yield* SqlClient.SqlClient;
        const issued = yield* devices.issue(issueInput);
        const rows = yield* sql`SELECT * FROM auth_devices`;
        expect(rows.some((row) => Object.values(row).includes(issued.refreshToken))).toBe(false);
        expect(
          (yield* Effect.flip(devices.refresh(issued.refreshToken, "attacker", "wrong-key")))._tag,
        ).toBe("SessionCredentialInvalidError");
        expect((yield* Effect.flip(devices.logout(issued.refreshToken, "wrong-key")))._tag).toBe(
          "SessionCredentialInvalidError",
        );
        expect(
          (yield* devices.refresh(issued.refreshToken, "legitimate", "device-key")).sessionId,
        ).toBe(issued.sessionId);
      }).pipe(Effect.provide(fixture)),
  );

  it.effect("concurrent identical refresh operations rotate once and recover a lost response", () =>
    Effect.gen(function* () {
      const devices = yield* DurableDeviceAuthorization;
      const sql = yield* SqlClient.SqlClient;
      const issued = yield* devices.issue(issueInput);
      const results = yield* Effect.all(
        [
          devices.refresh(issued.refreshToken, "same-operation", "device-key"),
          devices.refresh(issued.refreshToken, "same-operation", "device-key"),
        ],
        { concurrency: 2 },
      );
      expect(results[0]!.refreshToken).toBe(results[1]!.refreshToken);
      expect((yield* sql`SELECT * FROM auth_device_refresh_history`).length).toBe(1);
      const retried = yield* devices.refresh(issued.refreshToken, "same-operation", "device-key");
      expect(retried.refreshToken).toBe(results[0]!.refreshToken);
    }).pipe(Effect.provide(fixture)),
  );

  it.effect("different concurrent operations fail closed and revoke only the replayed device", () =>
    Effect.gen(function* () {
      const devices = yield* DurableDeviceAuthorization;
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* devices.issue(issueInput);
      const other = yield* devices.issue(issueInput);
      const results = yield* Effect.all(
        [
          devices.refresh(issued.refreshToken, "operation-a", "device-key").pipe(Effect.result),
          devices.refresh(issued.refreshToken, "operation-b", "device-key").pipe(Effect.result),
        ],
        { concurrency: 2 },
      );
      expect(results.filter((r) => r._tag === "Success")).toHaveLength(1);
      expect((yield* Effect.flip(sessions.verify(issued.token)))._tag).toBe(
        "SessionCredentialInvalidError",
      );
      expect((yield* sessions.verify(other.token)).sessionId).toBe(other.sessionId);
    }).pipe(Effect.provide(fixture)),
  );

  it.effect(
    "rejects stale refresh replays after a second rotation and revokes all access for that device",
    () =>
      Effect.gen(function* () {
        const devices = yield* DurableDeviceAuthorization;
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* devices.issue(issueInput);
        const first = yield* devices.refresh(issued.refreshToken, "first", "device-key");
        const second = yield* devices.refresh(first.refreshToken, "second", "device-key");
        yield* Effect.flip(devices.refresh(issued.refreshToken, "first", "device-key"));
        yield* Effect.flip(sessions.verify(second.token));
        yield* Effect.flip(devices.refresh(second.refreshToken, "third", "device-key"));
      }).pipe(Effect.provide(fixture)),
  );

  it.effect("preserves explicit logout, administrative revoke and revoke-other-clients", () =>
    Effect.gen(function* () {
      const devices = yield* DurableDeviceAuthorization;
      const sessions = yield* SessionStore.SessionStore;
      const first = yield* devices.issue(issueInput);
      const rotated = yield* devices.refresh(first.refreshToken, "first", "device-key");
      expect(yield* devices.logout(first.refreshToken, "device-key")).toBe(true);
      expect(yield* devices.logout(rotated.refreshToken, "device-key")).toBe(false);
      yield* Effect.flip(sessions.verify(rotated.token));
      yield* Effect.flip(devices.refresh(rotated.refreshToken, "next", "device-key"));
      const second = yield* devices.issue(issueInput);
      yield* sessions.revoke(second.sessionId);
      yield* Effect.flip(devices.refresh(second.refreshToken, "next", "device-key"));
      const owner = yield* sessions.issue();
      const third = yield* devices.issue(issueInput);
      yield* sessions.revokeAllExcept(owner.sessionId);
      yield* Effect.flip(devices.refresh(third.refreshToken, "next", "device-key"));
      expect((yield* sessions.verify(owner.token)).sessionId).toBe(owner.sessionId);
    }).pipe(Effect.provide(fixture)),
  );
});
