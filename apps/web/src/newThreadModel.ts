import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import {
  type NewConversationModelSettings,
  resolveNewConversationModel,
} from "@t3tools/shared/modelResolution";

/**
 * The model a new chat opens on: the shared rule in
 * `resolveNewConversationModel`, fed with what only the web knows — the
 * composer's pending pick, which wins over its persisted thread.
 *
 * Null leaves the choice to the composer, which happens only when no account
 * is offering anything to choose from.
 */
export function resolveNewThreadModelSelection(input: {
  settings: NewConversationModelSettings | null;
  currentThreadSelection: ModelSelection | null;
  currentComposer: {
    activeProvider?: ProviderInstanceId | null;
    modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  } | null;
  /** The target project's stored default, if it has one. */
  projectDefault?: ModelSelection | null;
  /** What the connected accounts are offering. Empty means not known yet. */
  providers?: ReadonlyArray<ServerProvider>;
}): ModelSelection | null {
  const instanceId =
    input.currentComposer?.activeProvider ?? input.currentThreadSelection?.instanceId;
  const inherited =
    (instanceId ? input.currentComposer?.modelSelectionByProvider[instanceId] : null) ??
    input.currentThreadSelection;

  const resolution = resolveNewConversationModel({
    settings: input.settings,
    providers: input.providers ?? [],
    inherited,
    projectDefault: input.projectDefault ?? null,
  });
  return resolution.outcome === "resolved" && resolution.source !== "available"
    ? resolution.selection
    : null;
}
