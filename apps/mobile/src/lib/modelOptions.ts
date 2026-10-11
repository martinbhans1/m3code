import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly selection: ModelSelection;
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

/**
 * The model's name, plus the account that runs it whenever another account of
 * the same driver is also selectable ("Opus 5.5 · Claude Max 5x").
 */
export function describeModelOption(
  option: ModelOption,
  options: ReadonlyArray<ModelOption>,
): string {
  return instancesSharingDriver(options).has(option.providerKey)
    ? `${option.label} · ${option.providerLabel}`
    : option.label;
}
