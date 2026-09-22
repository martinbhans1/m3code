import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ServerProviderAuthenticateError,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "./testUtils/providerRegistryMock.ts";
import * as ProviderAuthenticationRunner from "./providerAuthenticationRunner.ts";

const INSTANCE_ID = ProviderInstanceId.make("claude_personal");
const isAuthenticationError = Schema.is(ServerProviderAuthenticateError);

const makeRunner = (registry: ProviderRegistry["Service"]) =>
  Effect.service(ProviderAuthenticationRunner.ProviderAuthenticationRunner).pipe(
    Effect.provide(
      ProviderAuthenticationRunner.layer.pipe(
        Layer.provide(Layer.succeed(ProviderRegistry, registry)),
      ),
    ),
  );

describe("providerAuthenticationRunner", () => {
  it.effect("authenticates and refreshes the selected provider instance", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const refreshedProviders: ReadonlyArray<ServerProvider> = [];
      const runner = yield* makeRunner({
        ...makeProviderRegistryMock(),
        authenticateInstance: (instanceId) =>
          Effect.sync(() => calls.push(`authenticate:${instanceId}`)).pipe(Effect.asVoid),
        refreshInstance: (instanceId) =>
          Effect.sync(() => {
            calls.push(`refresh:${instanceId}`);
            return refreshedProviders;
          }),
      });

      const result = yield* runner.authenticateProvider({ instanceId: INSTANCE_ID });

      assert.deepStrictEqual(result.providers, refreshedProviders);
      assert.deepStrictEqual(calls, ["authenticate:claude_personal", "refresh:claude_personal"]);
    }),
  );

  it.effect("rejects a second concurrent sign-in for the same instance", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const runner = yield* makeRunner({
        ...makeProviderRegistryMock(),
        authenticateInstance: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
      });

      const first = yield* runner
        .authenticateProvider({ instanceId: INSTANCE_ID })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* runner
        .authenticateProvider({ instanceId: INSTANCE_ID })
        .pipe(Effect.flip);

      assert.isTrue(isAuthenticationError(second));
      assert.include(second.reason, "already running");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
    }),
  );
});
