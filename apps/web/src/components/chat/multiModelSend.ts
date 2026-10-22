/**
 * Pure logic for starting one new-thread prompt on several models at once.
 *
 * A "selection" is an instance + model pair, so the same model on three
 * Claude accounts is three picks. Each pick becomes its own thread in its own
 * new worktree; nothing here touches React or the network directly, so the
 * picker state and the send orchestration can be tested in isolation.
 */
import {
  OrchestrationDispatchCommandError,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderOptionSelection,
  type ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { truncate } from "@t3tools/shared/String";
import * as Schema from "effect/Schema";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { getDisplayModelName } from "./providerIconUtils";

type InstanceModel = Pick<ModelSelection, "instanceId" | "model">;

export function multiModelSelectionKey(selection: InstanceModel): string {
  return `${selection.instanceId}:${selection.model}`;
}

/**
 * Shift-click on a model row. Adds the pick when absent, removes it when
 * present. Starting from single-select, the composer's current model is the
 * first pick so shift-clicking a second model yields two.
 *
 * Fewer than two picks collapses back to single-select: `multi` is null and
 * `single` names the model the composer should now show.
 */
export function toggleMultiModelSelection(input: {
  readonly current: ReadonlyArray<ModelSelection> | null;
  readonly primary: ModelSelection;
  readonly toggled: InstanceModel;
  readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
}): { readonly multi: ReadonlyArray<ModelSelection> | null; readonly single: ModelSelection } {
  const current = input.current ?? [input.primary];
  const toggledKey = multiModelSelectionKey(input.toggled);
  const exists = current.some((selection) => multiModelSelectionKey(selection) === toggledKey);
  const next = exists
    ? current.filter((selection) => multiModelSelectionKey(selection) !== toggledKey)
    : [
        ...current,
        createModelSelection(input.toggled.instanceId, input.toggled.model, input.options),
      ];
  if (next.length >= 2) {
    return { multi: next, single: next[0]! };
  }
  return { multi: null, single: next[0] ?? input.primary };
}

/**
 * One short name per pick for the picker trigger. The model name normally
 * suffices; when two picks share it (the same model on two accounts) the
 * account name is what tells them apart.
 */
export function resolveMultiModelLabels(
  selections: ReadonlyArray<InstanceModel>,
  names: {
    readonly modelName: (selection: InstanceModel) => string;
    readonly instanceName: (selection: InstanceModel) => string;
  },
): string[] {
  const modelNames = selections.map(names.modelName);
  return selections.map((selection, index) => {
    const modelName = modelNames[index]!;
    const shared = modelNames.filter((name) => name === modelName).length > 1;
    return shared ? names.instanceName(selection) : modelName;
  });
}

/** "A, B, +2" — the picker trigger's compact label. */
export function formatMultiModelTriggerLabel(labels: ReadonlyArray<string>): string {
  if (labels.length <= 2) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")}, +${labels.length - 2}`;
}

/** Why a multi-model send cannot go out, or null when it can. */
export function resolveMultiModelSendBlockReason(input: {
  readonly isGitRepo: boolean;
  readonly baseBranch: string | null;
  readonly projectCwd: string | null | undefined;
}): string | null {
  if (!input.isGitRepo || !input.projectCwd) {
    return "Several models need a Git project";
  }
  if (!input.baseBranch) {
    return "Pick a base branch for the worktrees";
  }
  return null;
}

function findModel(entry: ProviderInstanceEntry | undefined, slug: string) {
  return entry?.models.find((model) => model.slug === slug);
}

/**
 * Short label naming each pick in its thread title, so the sibling threads
 * are tell-apart in the sidebar. The instance name is enough unless two
 * picks share it, in which case the model name is added.
 */
export function resolveMultiModelTitleSuffixes(
  selections: ReadonlyArray<InstanceModel>,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): string[] {
  const instanceLabel = (selection: InstanceModel) =>
    entries.find((entry) => entry.instanceId === selection.instanceId)?.displayName ??
    selection.instanceId;
  const counts = new Map<string, number>();
  for (const selection of selections) {
    const label = instanceLabel(selection);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return selections.map((selection) => {
    const label = instanceLabel(selection);
    if ((counts.get(label) ?? 0) < 2) return label;
    const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
    const model = findModel(entry, selection.model);
    const modelLabel = model
      ? getDisplayModelName(model, { preferShortName: true })
      : selection.model;
    return `${label} ${modelLabel}`;
  });
}

export function formatMultiModelThreadTitle(titleSeed: string, suffix: string): string {
  return `${truncate(titleSeed)} · ${suffix}`;
}

export interface MultiModelTarget {
  readonly selection: ModelSelection;
  readonly driverKind: ProviderDriverKind;
  readonly models: ProviderInstanceEntry["models"];
  /** Names the pick in toasts and as the thread title's suffix. */
  readonly label: string;
  readonly title: string;
}

/**
 * Each pick resolved against the live provider list. A pick whose instance
 * was removed, disabled or is not ready fails here rather than mid-send.
 */
export function resolveMultiModelTargets(input: {
  readonly selections: ReadonlyArray<ModelSelection>;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly titleSeed: string;
}):
  | { readonly ok: true; readonly targets: ReadonlyArray<MultiModelTarget> }
  | { readonly ok: false; readonly error: string } {
  const suffixes = resolveMultiModelTitleSuffixes(input.selections, input.entries);
  const targets: MultiModelTarget[] = [];
  for (const [index, selection] of input.selections.entries()) {
    const entry = input.entries.find((candidate) => candidate.instanceId === selection.instanceId);
    if (!entry) {
      return {
        ok: false,
        error: `${selection.model} is no longer available: its provider was removed. Pick the models again.`,
      };
    }
    if (!entry.enabled || !entry.isAvailable || entry.status !== "ready") {
      return {
        ok: false,
        error: `${entry.displayName} is not ready. Enable or sign in to it, or drop it from the selection.`,
      };
    }
    targets.push({
      selection,
      driverKind: entry.driverKind,
      models: entry.models,
      label: suffixes[index]!,
      title: formatMultiModelThreadTitle(input.titleSeed, suffixes[index]!),
    });
  }
  return { ok: true, targets };
}

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

/**
 * Whether a failed bootstrap request definitely left no thread behind.
 *
 * The server answers every bootstrap failure it processed with a dispatch
 * error, and by then it has already deleted the thread it created. Anything
 * else (a dropped socket, a timeout) means the request may have landed, so
 * the thread may exist. A duplicate-id rejection means an earlier delivery of
 * this same request did land.
 */
export function classifyBootstrapFailure(error: unknown): "not-started" | "uncertain" {
  if (isOrchestrationDispatchCommandError(error) && !/already exists/i.test(error.message)) {
    return "not-started";
  }
  return "uncertain";
}

export type MultiModelStartResult<T extends MultiModelTargetLike> =
  | { readonly status: "started"; readonly target: T; readonly threadId: ThreadId }
  | {
      readonly status: "not-started" | "uncertain";
      readonly target: T;
      readonly threadId: ThreadId;
      readonly error: unknown;
    };

type MultiModelTargetLike = { readonly selection: ModelSelection };

/**
 * Starts each target one after another, each under a fresh thread id.
 *
 * Sequential on purpose: every start runs `git worktree add` against the same
 * repository, and git takes a lock on the shared config and refs while it
 * does. Concurrent adds fail outright ("could not lock config file") rather
 * than queueing, which would turn one send into several spurious failures.
 * The cost is a few seconds for a handful of models.
 */
export async function startMultiModelThreads<T extends MultiModelTargetLike>(input: {
  readonly targets: ReadonlyArray<T>;
  readonly newThreadId: () => ThreadId;
  readonly start: (target: T, threadId: ThreadId) => Promise<unknown>;
}): Promise<ReadonlyArray<MultiModelStartResult<T>>> {
  const results: MultiModelStartResult<T>[] = [];
  for (const target of input.targets) {
    const threadId = input.newThreadId();
    try {
      await input.start(target, threadId);
      results.push({ status: "started", target, threadId });
    } catch (error) {
      results.push({ status: classifyBootstrapFailure(error), target, threadId, error });
    }
  }
  return results;
}

/**
 * The selection to put back after a partly failed send: only the picks that
 * definitely did not start. An uncertain pick is left out so sending again
 * cannot quietly create a duplicate thread.
 */
export function resolveSelectionsToRestore<T extends MultiModelTargetLike>(
  results: ReadonlyArray<MultiModelStartResult<T>>,
): ReadonlyArray<ModelSelection> {
  return results
    .filter((result) => result.status === "not-started")
    .map((result) => result.target.selection);
}

/**
 * What to put back in the composer once a send finishes. The prompt only
 * returns when some pick can safely be retried: with nothing retryable the
 * composer would fall back to its single model, which may be one that just
 * started (or may have), and one Enter would send the prompt to it again.
 */
export function resolveMultiModelSendRestore<T extends MultiModelTargetLike>(
  results: ReadonlyArray<MultiModelStartResult<T>>,
): { readonly restorePrompt: boolean; readonly selections: ReadonlyArray<ModelSelection> } {
  if (results.every((result) => result.status === "started")) {
    return { restorePrompt: false, selections: [] };
  }
  const selections = resolveSelectionsToRestore(results);
  return { restorePrompt: selections.length > 0, selections };
}
