import {
  type GrokSettings,
  type ProviderOptionSelection,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { getProviderOptionStringSelectionValue, normalizeModelSlug } from "@t3tools/shared/model";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

const GROK_API_KEY_ENV = "XAI_API_KEY";
const GROK_OAUTH2_REFERRER_ENV = "GROK_OAUTH2_REFERRER";
const T3_CODE_OAUTH_REFERRER = "t3code";
const GROK_AUTH_METHOD_API_KEY = "xai.api_key";
const GROK_AUTH_METHOD_CACHED_TOKEN = "cached_token";
const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");

/** Option id advertised in Grok model capabilities and read from modelSelection.options. */
export const GROK_REASONING_EFFORT_OPTION_ID = "reasoningEffort";

/**
 * Values accepted by `grok agent --reasoning-effort` / the xAI API.
 * `xhigh` is supported on grok-4.6+; older models treat it as `high`.
 *
 * Distinct from Cursor "Fast" / xAI Priority Processing (`service_tier: "priority"`),
 * which controls inference scheduling priority and cost, not reasoning depth.
 */
export const GROK_REASONING_EFFORT_VALUES = ["low", "medium", "high", "xhigh"] as const;
export type GrokReasoningEffort = (typeof GROK_REASONING_EFFORT_VALUES)[number];
export const GROK_DEFAULT_REASONING_EFFORT: GrokReasoningEffort = "high";

type GrokAcpRuntimeGrokSettings = Pick<GrokSettings, "binaryPath">;

interface GrokAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly grokSettings: GrokAcpRuntimeGrokSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Reasoning effort applied at process spawn via `--reasoning-effort`.
   * Process-scoped: changing mid-session requires restarting the agent.
   */
  readonly reasoningEffort?: GrokReasoningEffort | null | undefined;
}

export function isGrokReasoningEffort(
  value: string | null | undefined,
): value is GrokReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

/**
 * Resolves reasoning effort from modelSelection options.
 * Unknown/missing values fall back to the xAI default (`high`).
 */
export function resolveGrokReasoningEffort(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): GrokReasoningEffort {
  const raw = getProviderOptionStringSelectionValue(selections, GROK_REASONING_EFFORT_OPTION_ID);
  const normalized = raw?.trim().toLowerCase();
  return isGrokReasoningEffort(normalized) ? normalized : GROK_DEFAULT_REASONING_EFFORT;
}

export function buildGrokAcpSpawnInput(
  grokSettings: GrokAcpRuntimeGrokSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  reasoningEffort?: GrokReasoningEffort | null | undefined,
): AcpSpawnInput {
  const effort = isGrokReasoningEffort(reasoningEffort)
    ? reasoningEffort
    : GROK_DEFAULT_REASONING_EFFORT;
  // Parent options must come before the `stdio` subcommand; trailing flags
  // after `stdio` are rejected (`unexpected argument '--reasoning-effort'`).
  return {
    command: grokSettings?.binaryPath || "grok",
    args: ["agent", "--reasoning-effort", effort, "stdio"],
    cwd,
    env: {
      ...environment,
      [GROK_OAUTH2_REFERRER_ENV]: T3_CODE_OAUTH_REFERRER,
    },
  };
}

function resolveGrokAuthMethodId(environment: NodeJS.ProcessEnv | undefined): string {
  return environment?.[GROK_API_KEY_ENV]?.trim()
    ? GROK_AUTH_METHOD_API_KEY
    : GROK_AUTH_METHOD_CACHED_TOKEN;
}

export const makeGrokAcpRuntime = (
  input: GrokAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGrokAcpSpawnInput(
          input.grokSettings,
          input.cwd,
          input.environment,
          input.reasoningEffort,
        ),
        authMethodId: resolveGrokAuthMethodId(input.environment),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

export function resolveGrokAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "grok-build";
  return normalizeModelSlug(base, GROK_DRIVER_KIND) ?? "grok-build";
}

export function currentGrokModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyGrokAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
