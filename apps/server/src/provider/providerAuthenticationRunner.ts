import {
  ServerProviderAuthenticateError,
  type ProviderInstanceId,
  type ServerProviderAuthenticateInput,
  type ServerProviderUpdatedPayload,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { ProviderRegistry } from "./Services/ProviderRegistry.ts";

const AUTHENTICATION_TIMEOUT = Duration.minutes(10);
const isServerProviderAuthenticateError = Schema.is(ServerProviderAuthenticateError);

export interface ProviderAuthenticationRunnerShape {
  readonly authenticateProvider: (
    input: ServerProviderAuthenticateInput,
  ) => Effect.Effect<ServerProviderUpdatedPayload, ServerProviderAuthenticateError>;
}

export class ProviderAuthenticationRunner extends Context.Service<
  ProviderAuthenticationRunner,
  ProviderAuthenticationRunnerShape
>()("t3/provider/providerAuthenticationRunner") {}

function authenticationError(instanceId: ProviderInstanceId, reason: string, cause?: unknown) {
  return new ServerProviderAuthenticateError({
    instanceId,
    reason,
    ...(cause === undefined ? {} : { cause }),
  });
}

export const make = Effect.fn("ProviderAuthenticationRunner.make")(function* () {
  const providers = yield* ProviderRegistry;
  const activeInstances = yield* Ref.make<ReadonlySet<ProviderInstanceId>>(new Set());

  const authenticateProvider: ProviderAuthenticationRunnerShape["authenticateProvider"] = Effect.fn(
    "ProviderAuthenticationRunner.authenticateProvider",
  )(function* ({ instanceId }) {
    const claimed = yield* Ref.modify(activeInstances, (active) => {
      if (active.has(instanceId)) return [false, active] as const;
      const next = new Set(active);
      next.add(instanceId);
      return [true, next] as const;
    });
    if (!claimed) {
      return yield* authenticationError(instanceId, "A sign-in flow is already running.");
    }

    const release = Ref.update(activeInstances, (active) => {
      const next = new Set(active);
      next.delete(instanceId);
      return next;
    });

    return yield* Effect.gen(function* () {
      if (!providers.authenticateInstance) {
        return yield* authenticationError(
          instanceId,
          "Provider authentication is unavailable in this runtime.",
        );
      }

      const completed = yield* providers.authenticateInstance(instanceId).pipe(
        Effect.timeoutOption(AUTHENTICATION_TIMEOUT),
        Effect.mapError((cause) => authenticationError(instanceId, cause.message, cause)),
      );
      if (Option.isNone(completed)) {
        return yield* authenticationError(
          instanceId,
          "Sign-in timed out after 10 minutes. You can safely try again.",
        );
      }

      return { providers: yield* providers.refreshInstance(instanceId) };
    }).pipe(
      Effect.catchCause((cause) => {
        const failure = Cause.squash(cause);
        return Effect.fail(
          isServerProviderAuthenticateError(failure)
            ? failure
            : authenticationError(
                instanceId,
                failure instanceof Error ? failure.message : "Provider sign-in failed.",
                failure,
              ),
        );
      }),
      Effect.ensuring(release),
    );
  });

  return ProviderAuthenticationRunner.of({ authenticateProvider });
});

export const layer = Layer.effect(ProviderAuthenticationRunner, make());
