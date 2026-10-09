import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { listRunnableModels, type RunnableModel } from "@t3tools/shared/modelResolution";
import type { ModelSelection } from "@t3tools/contracts";

import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";

/**
 * The models the connected accounts can start a turn on right now.
 *
 * Read optionally so callers that run without a provider registry (CLI
 * commands, narrow test layers) get an empty list — which the resolver treats
 * as "availability unknown", never as "nothing is runnable".
 */
export const readRunnableModels: Effect.Effect<ReadonlyArray<RunnableModel>> = Effect.gen(
  function* () {
    const registry = yield* Effect.serviceOption(ProviderRegistry);
    if (Option.isNone(registry)) return [];
    return listRunnableModels(yield* registry.value.getProviders);
  },
);

export const runnableToSelection = (model: RunnableModel): ModelSelection => ({
  instanceId: model.instanceId,
  model: model.slug,
});
