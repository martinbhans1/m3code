import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import { resolveNewConversationModel } from "@t3tools/shared/modelResolution";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly providerAccentColor?: string | undefined;
  readonly selection: ModelSelection;
};

/** Which account runs a model: initials on the account's colour, as on web. */
export type AccountBadge = {
  readonly text: string;
  readonly color: string | undefined;
};

export type ProviderGroup = {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly models: ReadonlyArray<ModelOption>;
};

function humanizeInstanceId(instanceId: string): string {
  return instanceId
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(" ")
    .filter((token) => token.length > 0)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

// Same tiers as the web picker: a configured name wins; an unnamed second
// account of a driver falls back to its slug so two "Claude" groups never
// read identically.
export function providerDisplayLabel(provider: {
  readonly displayName?: string | undefined;
  readonly driver: ProviderDriverKind;
  readonly instanceId: string;
}): string {
  const kindLabel = PROVIDER_DISPLAY_NAMES[provider.driver] ?? humanizeInstanceId(provider.driver);
  const name = provider.displayName?.trim();
  if (name && name !== kindLabel) return name;
  if (provider.instanceId !== defaultInstanceIdForDriver(provider.driver)) {
    const humanized = humanizeInstanceId(provider.instanceId);
    if (humanized.length > 0) return humanized;
  }
  return name || kindLabel;
}

/**
 * Instance ids whose driver has more than one selectable account, so the UI
 * knows when a bare model name ("Opus 5.5") is ambiguous about which account
 * runs it.
 */
function instancesSharingDriver(options: ReadonlyArray<ModelOption>): ReadonlySet<string> {
  const instancesByDriver = new Map<string, Set<string>>();
  for (const option of options) {
    const instances = instancesByDriver.get(option.providerDriver) ?? new Set<string>();
    instances.add(option.providerKey);
    instancesByDriver.set(option.providerDriver, instances);
  }
  const shared = new Set<string>();
  for (const instances of instancesByDriver.values()) {
    if (instances.size > 1) for (const instance of instances) shared.add(instance);
  }
  return shared;
}

export function buildModelOptions(
  config: T3ServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
): ReadonlyArray<ModelOption> {
  const options = new Map<string, ModelOption>();

  for (const provider of config?.providers ?? []) {
    if (!provider.enabled || !provider.installed || provider.auth.status === "unauthenticated") {
      continue;
    }

    const providerLabel = providerDisplayLabel(provider);
    for (const model of provider.models) {
      const key = `${provider.instanceId}:${model.slug}`;
      options.set(key, {
        key,
        label: model.name,
        subtitle: providerLabel,
        providerKey: provider.instanceId,
        providerLabel,
        providerDriver: provider.driver,
        providerAccentColor: normalizeAccentColor(provider.accentColor),
        selection: {
          instanceId: provider.instanceId,
          model: model.slug,
        },
      });
    }
  }

  if (fallbackModelSelection) {
    const key = `${fallbackModelSelection.instanceId}:${fallbackModelSelection.model}`;
    if (!options.has(key)) {
      const providerLabel = fallbackModelSelection.instanceId;
      options.set(key, {
        key,
        label: fallbackModelSelection.model,
        subtitle: providerLabel,
        providerKey: fallbackModelSelection.instanceId,
        providerLabel,
        providerDriver: fallbackModelSelection.instanceId,
        selection: fallbackModelSelection,
      });
    }
  }

  return [...options.values()];
}

export function groupByProvider(options: ReadonlyArray<ModelOption>): ReadonlyArray<ProviderGroup> {
  const groups = new Map<string, { providerLabel: string; models: ModelOption[] }>();
  for (const option of options) {
    const existing = groups.get(option.providerKey);
    if (existing) {
      existing.models.push(option);
    } else {
      groups.set(option.providerKey, {
        providerLabel: option.providerLabel,
        models: [option],
      });
    }
  }

  return [...groups.entries()].map(([providerKey, group]) => ({
    providerKey,
    providerLabel: group.providerLabel,
    models: group.models,
  }));
}

function normalizeAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^#[0-9a-fA-F]{6}$/u.test(trimmed) ? trimmed : undefined;
}

/** Same initials the web shows on its provider badge ("Claude Max 5x" -> "CM"). */
export function accountInitials(label: string): string {
  const words = label.replace(/[_-]+/g, " ").split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * The account badge to show beside a model, following the web picker: shown
 * when the account has its own colour or shares its driver with another
 * account, otherwise null and the model name alone is unambiguous.
 */
export function modelOptionAccountBadge(
  option: ModelOption,
  options: ReadonlyArray<ModelOption>,
): AccountBadge | null {
  if (!option.providerAccentColor && !instancesSharingDriver(options).has(option.providerKey)) {
    return null;
  }
  return { text: accountInitials(option.providerLabel), color: option.providerAccentColor };
}

/**
 * The model a new conversation from the phone starts on.
 *
 * The same rule the web composer, the orchestrator and integrations use, read
 * from the server's own settings: the default chosen in Settings > Chat, the
 * chat being continued, the project's stored model, then a starred model —
 * each checked against what the connected accounts offer. Null when nothing
 * can run, so the caller can say so instead of starting a dead model.
 */
export function resolveStartingModel(
  config: T3ServerConfig | null | undefined,
  input: {
    readonly projectDefault?: ModelSelection | null;
    readonly inherited?: ModelSelection | null;
  } = {},
): ModelSelection | null {
  const resolution = resolveNewConversationModel({
    settings: config?.settings ?? null,
    providers: config?.providers ?? [],
    projectDefault: input.projectDefault ?? null,
    inherited: input.inherited ?? null,
  });
  return resolution.outcome === "resolved" ? resolution.selection : null;
}
