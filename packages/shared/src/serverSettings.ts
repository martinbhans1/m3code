import { ServerSettings, type ServerSettingsPatch } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection } from "./model.ts";

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownOption(ServerSettingsJson);

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

export function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  const decoded = decodeServerSettingsJson(raw);
  if (Option.isSome(decoded)) {
    return extractPersistedServerObservabilitySettings(decoded.value);
  }
  return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
}

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

/**
 * Set or clear one thread's orchestrator access without touching the others.
 * A null access removes the key, which puts the thread back on
 * `defaultOrchestratorThreadAccess` rather than closing it.
 */
function applyOrchestratorThreadAccessEntry(input: {
  readonly current: ServerSettings["orchestratorThreadAccess"];
  readonly entry: { readonly threadId: string; readonly access: string | null };
}): ServerSettings["orchestratorThreadAccess"] {
  const next = { ...input.current } as Record<string, string>;
  if (input.entry.access === null) {
    delete next[input.entry.threadId];
  } else {
    next[input.entry.threadId] = input.entry.access;
  }
  return next as ServerSettings["orchestratorThreadAccess"];
}

/**
 * Applies a server settings patch while treating textGenerationModelSelection as
 * replace-on-provider/model updates. This prevents stale nested options from
 * surviving a reset patch that intentionally omits options.
 */
export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const { automaticGitFetchInterval, ...patchForMerge } = patch;
  const next = deepMerge(current, patchForMerge);
  const nextWithReplacements = {
    ...next,
    ...(patch.providerInstances !== undefined
      ? { providerInstances: patch.providerInstances }
      : {}),
    ...(patch.databaseConnections !== undefined
      ? { databaseConnections: patch.databaseConnections }
      : {}),
    // Replaced wholesale: `deepMerge` would union arrays index-wise and make
    // removing a model impossible.
    ...(patch.orchestratorModelChoices !== undefined
      ? { orchestratorModelChoices: patch.orchestratorModelChoices }
      : {}),
    // Replaced wholesale rather than deep-merged: revoking a thread's access
    // means removing its key, and a merge would silently keep the old entry.
    ...(patch.orchestratorThreadAccess !== undefined
      ? { orchestratorThreadAccess: patch.orchestratorThreadAccess }
      : {}),
    // The single-entry form is applied after the wholesale one, so a patch
    // carrying both ends with the specific key winning over the bulk write.
    ...(patch.orchestratorThreadAccessEntry !== undefined
      ? {
          orchestratorThreadAccess: applyOrchestratorThreadAccessEntry({
            current: patch.orchestratorThreadAccess ?? current.orchestratorThreadAccess,
            entry: patch.orchestratorThreadAccessEntry,
          }),
        }
      : {}),
    ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
  };
  if (!selectionPatch) {
    return nextWithReplacements;
  }

  const instanceId = selectionPatch.instanceId ?? current.textGenerationModelSelection.instanceId;
  const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : mergeModelSelectionOptionsById({
        current: current.textGenerationModelSelection.options,
        patch: selectionPatch.options,
      });

  return {
    ...nextWithReplacements,
    textGenerationModelSelection: createModelSelection(instanceId, model, options),
  };
}
