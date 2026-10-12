/**
 * One place that answers "which model should this new conversation start on?".
 *
 * Every entry point that opens a thread — the composer when a chat loads, a
 * new project, a thread the orchestrator creates without naming a model —
 * used to carry its own `?? DEFAULT_MODEL` tail. That meant a code constant
 * silently outranked the user's configured default, and froze whatever the
 * constant happened to be on the day the record was written: projects created
 * while `DEFAULT_MODEL` was `gpt-5.4` kept pinning `gpt-5.4` long after the
 * account stopped being able to run it, which fails the turn with a provider
 * 400 rather than falling back.
 *
 * So: candidates in priority order, each checked against what the account can
 * actually run, and an explicit failure when nothing survives. No constant is
 * the last resort.
 *
 * This resolves the *starting* model only. A thread that already has a stored
 * `modelSelection` keeps it — that is a deliberate choice and nothing here
 * reconsiders it.
 */
import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { isProviderAvailable } from "@t3tools/contracts";

/** A model an enabled provider instance is currently offering. */
export interface RunnableModel {
  readonly instanceId: ProviderInstanceId;
  readonly slug: string;
}

/**
 * Every model the account can actually start a turn on right now.
 *
 * Disabled and unavailable instances contribute nothing: a model listed under
 * a signed-out provider is exactly the case that used to fail the first turn
 * with a provider 400 instead of falling back to something runnable.
 *
 * An empty result means "nothing known to be runnable", which callers must
 * treat as unknown rather than as empty — see `isRunnableModel`.
 */
export function listRunnableModels(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<RunnableModel> {
  const runnable: Array<RunnableModel> = [];
  for (const provider of providers) {
    // Same test the model pickers use for "accessible", so the list a default
    // is chosen from and the list it is checked against are one list.
    if (
      !provider.enabled ||
      !provider.installed ||
      provider.auth.status === "unauthenticated" ||
      !isProviderAvailable(provider)
    ) {
      continue;
    }
    for (const model of provider.models) {
      runnable.push({ instanceId: provider.instanceId, slug: model.slug });
    }
  }
  return runnable;
}

/**
 * Where a resolved selection came from, most deliberate first.
 *
 * - `explicit`   — the caller named this model for this conversation.
 * - `default`    — Settings > Chat > Default model, with the default enabled.
 * - `project`    — the project's own stored default.
 * - `inherited`  — the conversation that asked for this one.
 * - `favorite`   — the first starred model the account can run.
 * - `available`  — any runnable model, because nothing above applied.
 */
export type ModelSource =
  | "explicit"
  | "default"
  | "project"
  | "inherited"
  | "favorite"
  | "available";

export interface ModelCandidate {
  readonly source: ModelSource;
  readonly selection: ModelSelection;
}

/** The order candidates are considered in. Earlier is more deliberate. */
export const MODEL_SOURCE_PRIORITY: ReadonlyArray<ModelSource> = [
  "explicit",
  "default",
  "project",
  "inherited",
  "favorite",
  "available",
];

export interface StarredModel {
  /**
   * Stored as `provider` for persistence stability, but the value is a
   * `ProviderInstanceId` — see the `favorites` comment in settings.ts.
   */
  readonly provider: ProviderInstanceId;
  readonly model: string;
}

export type ModelResolution =
  | {
      readonly outcome: "resolved";
      readonly selection: ModelSelection;
      readonly source: ModelSource;
      /**
       * False when the provider model list was empty, so availability could
       * not be checked — a provider-status timeout, or providers not loaded
       * yet. The selection is still returned (refusing to open a conversation
       * because a status probe timed out would be worse), but callers should
       * not claim it was verified.
       */
      readonly verified: boolean;
      /** Candidates passed over because the account cannot run them. */
      readonly skipped: ReadonlyArray<ModelCandidate>;
    }
  | {
      readonly outcome: "unsupported";
      /** Why nothing could be chosen, phrased for the user. */
      readonly message: string;
      readonly skipped: ReadonlyArray<ModelCandidate>;
    };

function sameModel(a: ModelSelection, b: RunnableModel): boolean {
  return a.instanceId === b.instanceId && a.model === b.slug;
}

/**
 * Whether the account can run this selection right now.
 *
 * An empty `runnable` list means "unknown", not "nothing is runnable", and
 * answers `true` so a provider-status timeout cannot block thread creation.
 * Callers that need the distinction read `verified` on the resolution.
 */
export function isRunnableModel(
  runnable: ReadonlyArray<RunnableModel>,
  selection: ModelSelection,
): boolean {
  if (runnable.length === 0) return true;
  return runnable.some((candidate) => sameModel(selection, candidate));
}

export interface ResolveModelSelectionInput {
  /** What the account can run. Empty means availability is unknown. */
  readonly runnable: ReadonlyArray<RunnableModel>;
  /** The caller named this model for this conversation. */
  readonly explicit?: ModelSelection | null;
  /** Settings > Chat default, already gated on `defaultModelEnabled`. */
  readonly configuredDefault?: ModelSelection | null;
  /** The target project's stored default. */
  readonly projectDefault?: ModelSelection | null;
  /** The conversation that asked for this one. */
  readonly inherited?: ModelSelection | null;
  /** The user's starred models, in their own order. */
  readonly favorites?: ReadonlyArray<StarredModel>;
  /** Turn a runnable model into a full selection (options, effort, …). */
  readonly toSelection: (model: RunnableModel) => ModelSelection;
  /**
   * Where `inherited` ranks. Defaults to after the project's default, which
   * suits server callers whose "inherited" is an orchestrator conversation.
   * A chat the user is sitting in ranks higher — see
   * `resolveNewConversationModel`.
   */
  readonly inheritedRank?: "before-default" | "after-default" | "after-project";
}

/**
 * Walk the candidates in priority order and return the first one the account
 * can run, recording the ones stepped over so the caller can say so.
 */
export function resolveModelSelection(input: ResolveModelSelectionInput): ModelResolution {
  const verified = input.runnable.length > 0;
  const candidates: Array<ModelCandidate> = [];

  const push = (source: ModelSource, selection: ModelSelection | null | undefined) => {
    if (selection) candidates.push({ source, selection });
  };

  const inheritedRank = input.inheritedRank ?? "after-project";
  push("explicit", input.explicit);
  if (inheritedRank === "before-default") push("inherited", input.inherited);
  push("default", input.configuredDefault);
  if (inheritedRank === "after-default") push("inherited", input.inherited);
  push("project", input.projectDefault);
  if (inheritedRank === "after-project") push("inherited", input.inherited);

  // Starred models are a standing statement of what the user prefers, so they
  // come before "whatever the provider happens to list first".
  for (const favorite of input.favorites ?? []) {
    const match = input.runnable.find(
      (candidate) =>
        candidate.instanceId === favorite.provider && candidate.slug === favorite.model,
    );
    // A star naming a model no provider offers is stale, not a candidate; it
    // would only ever be skipped, and listing it as skipped is noise.
    if (match) push("favorite", input.toSelection(match));
  }

  const firstRunnable = input.runnable[0];
  if (firstRunnable) push("available", input.toSelection(firstRunnable));

  const skipped: Array<ModelCandidate> = [];
  for (const candidate of candidates) {
    if (isRunnableModel(input.runnable, candidate.selection)) {
      return {
        outcome: "resolved",
        selection: candidate.selection,
        source: candidate.source,
        verified,
        skipped,
      };
    }
    skipped.push(candidate);
  }

  return {
    outcome: "unsupported",
    message:
      skipped.length > 0
        ? `None of the models this conversation could start on are available on the connected accounts (tried ${skipped
            .map((candidate) => candidate.selection.model)
            .join(", ")}). Pick a model in the composer, or check the provider is signed in.`
        : "No provider is offering a model right now, so there is nothing to start this conversation on. Check that a provider is enabled and signed in.",
    skipped,
  };
}

/** The settings every surface reads to choose a new conversation's model. */
export interface NewConversationModelSettings {
  readonly defaultModelEnabled: boolean;
  readonly defaultModelSelection: ModelSelection | null;
  readonly favorites: ReadonlyArray<StarredModel>;
}

/**
 * The one rule for "which model does a new conversation start on", shared by
 * the web composer, the mobile app, the orchestrator and integrations so they
 * cannot drift apart again.
 *
 * Settings > Chat > Default model is the user's default everywhere. Its
 * switch only decides whether that default also beats the chat they are
 * sitting in (`inherited`): on, the default wins; off, the current chat wins
 * and the default is the fallback. Either way the default outranks a
 * project's stored model, which in practice is whatever the code pinned the
 * day the project was added rather than anything chosen.
 *
 * Everything is checked against what the connected accounts offer — the same
 * list the default is picked from — so a new model works the moment it is
 * chosen, and a retired one is stepped over instead of started.
 */
export function resolveNewConversationModel(input: {
  readonly settings: NewConversationModelSettings | null | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly explicit?: ModelSelection | null;
  readonly inherited?: ModelSelection | null;
  readonly projectDefault?: ModelSelection | null;
}): ModelResolution {
  return resolveModelSelection({
    runnable: listRunnableModels(input.providers),
    explicit: input.explicit ?? null,
    configuredDefault: input.settings?.defaultModelSelection ?? null,
    inherited: input.inherited ?? null,
    inheritedRank: input.settings?.defaultModelEnabled ? "after-default" : "before-default",
    projectDefault: input.projectDefault ?? null,
    favorites: input.settings?.favorites ?? [],
    toSelection: (model) => ({ instanceId: model.instanceId, model: model.slug }),
  });
}

/**
 * The models the orchestrator may open a conversation on.
 *
 * Defaults to the user's starred models, so curating the model picker curates
 * the orchestrator too and there is only one list to keep current. The
 * explicit `orchestratorModelChoices` list stays available behind
 * `orchestratorModelSource: "custom"`, for the case where the set you want it
 * routing between is not the set you want starred in your own picker.
 *
 * Entries no enabled provider is offering are dropped: offering the
 * orchestrator a model it cannot start is how it picked a dead one and failed
 * on the first message.
 */
export function listOrchestratorModelChoices(input: {
  readonly source: "favorites" | "custom";
  readonly favorites: ReadonlyArray<StarredModel>;
  readonly customChoices: ReadonlyArray<ModelSelection>;
  readonly runnable: ReadonlyArray<RunnableModel>;
  readonly toSelection: (model: RunnableModel) => ModelSelection;
}): ReadonlyArray<ModelSelection> {
  if (input.source === "custom") {
    return input.customChoices.filter((choice) => isRunnableModel(input.runnable, choice));
  }

  const choices: Array<ModelSelection> = [];
  for (const favorite of input.favorites) {
    const match = input.runnable.find(
      (candidate) =>
        candidate.instanceId === favorite.provider && candidate.slug === favorite.model,
    );
    if (match) {
      choices.push(input.toSelection(match));
      continue;
    }
    // Availability unknown (no provider list yet): keep the star rather than
    // silently narrowing what the orchestrator may choose.
    if (input.runnable.length === 0) {
      choices.push({ instanceId: favorite.provider, model: favorite.model });
    }
  }
  return choices;
}

/**
 * A line to show the user when the model they had configured could not be
 * used, so a substitution is never silent. Null when nothing was substituted.
 */
export function describeModelFallback(resolution: ModelResolution): string | null {
  if (resolution.outcome === "unsupported") return resolution.message;
  const displaced = resolution.skipped[0];
  if (!displaced) return null;
  return `${displaced.selection.model} is not available on the connected accounts, so this conversation started on ${resolution.selection.model} instead.`;
}
