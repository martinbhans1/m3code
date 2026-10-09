import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { listRunnableModels, resolveModelSelection } from "@t3tools/shared/modelResolution";

/** The current composer's pending model choice wins over its persisted thread. */
export function resolveNewThreadModelSelection(input: {
  defaultSelection: ModelSelection | null;
  currentThreadSelection: ModelSelection | null;
  currentComposer: {
    activeProvider?: ProviderInstanceId | null;
    modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  } | null;
  /** The target project's stored default, if it has one. */
  projectDefault?: ModelSelection | null;
  /** The models starred in the picker, in the user's order. */
  favorites?: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>;
  /** What the connected accounts are offering. Empty means not known yet. */
  providers?: ReadonlyArray<ServerProvider>;
}): ModelSelection | null {
  if (input.defaultSelection) return input.defaultSelection;
  const instanceId =
    input.currentComposer?.activeProvider ?? input.currentThreadSelection?.instanceId;
  const inherited =
    (instanceId ? input.currentComposer?.modelSelectionByProvider[instanceId] : null) ??
    input.currentThreadSelection;
  if (inherited) return inherited;

  // Nothing to inherit — the first chat in a fresh window, or a project with
  // no stored model. The project's own default stays in charge when the
  // account can run it (returning null lets the composer use it). Otherwise
  // start on a starred model rather than on whatever a provider lists first,
  // which is how a retired model kept coming back.
  const resolution = resolveModelSelection({
    runnable: listRunnableModels(input.providers ?? []),
    projectDefault: input.projectDefault ?? null,
    favorites: input.favorites ?? [],
    toSelection: (model) => ({ instanceId: model.instanceId, model: model.slug }),
  });
  return resolution.outcome === "resolved" && resolution.source === "favorite"
    ? resolution.selection
    : null;
}
