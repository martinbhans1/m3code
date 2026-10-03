import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

/** The current composer's pending model choice wins over its persisted thread. */
export function resolveNewThreadModelSelection(input: {
  defaultSelection: ModelSelection | null;
  currentThreadSelection: ModelSelection | null;
  currentComposer: {
    activeProvider?: ProviderInstanceId | null;
    modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  } | null;
}): ModelSelection | null {
  if (input.defaultSelection) return input.defaultSelection;
  const instanceId =
    input.currentComposer?.activeProvider ?? input.currentThreadSelection?.instanceId;
  return (
    (instanceId ? input.currentComposer?.modelSelectionByProvider[instanceId] : null) ??
    input.currentThreadSelection
  );
}
