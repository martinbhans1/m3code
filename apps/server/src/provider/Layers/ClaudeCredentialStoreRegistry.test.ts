import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  ClaudeCredentialStoreRegistry,
  ClaudeCredentialStoreRegistryLive,
} from "./ClaudeCredentialStoreRegistry.ts";

const SHARED_DIR = String.raw`C:\Users\Martin\.claude`;
const OWN_DIR = String.raw`C:\Users\Martin\.claude-personal`;

const at = (configDirPath: string) => ({
  configDirPath,
  credentialsPath: `${configDirPath}\\.credentials.json`,
});

const personalId = ProviderInstanceId.make("claude_personal");
const workId = ProviderInstanceId.make("claude_work");

describe("ClaudeCredentialStoreRegistry", () => {
  it.effect("names the other enabled instance reading the same config dir", () =>
    Effect.gen(function* () {
      const registry = yield* ClaudeCredentialStoreRegistry;
      yield* registry.register({
        instanceId: personalId,
        label: "Personal",
        locate: Effect.succeed(at(SHARED_DIR)),
      });
      yield* registry.register({
        instanceId: workId,
        label: "Work",
        locate: Effect.succeed(at(SHARED_DIR)),
      });

      expect((yield* registry.sharingFor(personalId))?.sharedWith).toEqual(["Work"]);
      expect((yield* registry.sharingFor(workId))?.sharedWith).toEqual(["Personal"]);
    }).pipe(Effect.scoped, Effect.provide(ClaudeCredentialStoreRegistryLive)),
  );

  it.effect("stops naming an instance once its scope closes", () =>
    Effect.gen(function* () {
      const registry = yield* ClaudeCredentialStoreRegistry;
      yield* registry.register({
        instanceId: personalId,
        label: "Personal",
        locate: Effect.succeed(at(SHARED_DIR)),
      });

      yield* Effect.gen(function* () {
        yield* registry.register({
          instanceId: workId,
          label: "Work",
          locate: Effect.succeed(at(SHARED_DIR)),
        });
        expect((yield* registry.sharingFor(personalId))?.sharedWith).toEqual(["Work"]);
      }).pipe(Effect.scoped);

      expect(yield* registry.sharingFor(personalId)).toBe(undefined);
    }).pipe(Effect.scoped, Effect.provide(ClaudeCredentialStoreRegistryLive)),
  );

  it.effect("re-reads each instance's paths, so sharing introduced later is caught", () =>
    Effect.gen(function* () {
      const registry = yield* ClaudeCredentialStoreRegistry;
      // A symlink written by something outside this app after boot: the
      // personal dir starts with its own file and ends up on the shared one.
      const personalLocation = yield* Ref.make(at(OWN_DIR));
      yield* registry.register({
        instanceId: personalId,
        label: "Personal",
        locate: Ref.get(personalLocation),
      });
      yield* registry.register({
        instanceId: workId,
        label: "Work",
        locate: Effect.succeed(at(SHARED_DIR)),
      });

      expect(yield* registry.sharingFor(personalId)).toBe(undefined);

      yield* Ref.set(personalLocation, {
        configDirPath: OWN_DIR,
        credentialsPath: `${SHARED_DIR}\\.credentials.json`,
      });

      const sharing = yield* registry.sharingFor(personalId);
      expect(sharing?.sharedWith).toEqual(["Work"]);
      expect(sharing?.storePathOutsideConfigDir).toBe(`${SHARED_DIR}\\.credentials.json`);
    }).pipe(Effect.scoped, Effect.provide(ClaudeCredentialStoreRegistryLive)),
  );

  it.effect("reports nothing for an instance that never registered", () =>
    Effect.gen(function* () {
      const registry = yield* ClaudeCredentialStoreRegistry;

      expect(yield* registry.sharingFor(personalId)).toBe(undefined);
    }).pipe(Effect.scoped, Effect.provide(ClaudeCredentialStoreRegistryLive)),
  );
});
