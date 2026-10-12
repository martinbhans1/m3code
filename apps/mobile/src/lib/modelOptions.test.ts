import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind, type ServerConfig } from "@t3tools/contracts";

import {
  accountShorthand,
  buildModelOptions,
  modelOptionAccountBadge,
  providerDisplayLabel,
  resolveStartingModel,
} from "./modelOptions";

function makeConfig(
  providers: ReadonlyArray<{ instanceId: string; driver: string; displayName?: string }>,
): ServerConfig {
  return {
    providers: providers.map((provider) => ({
      ...provider,
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities: null }],
    })),
  } as unknown as ServerConfig;
}

const claudeAgent = ProviderDriverKind.make("claudeAgent");

describe("providerDisplayLabel", () => {
  it("prefers a configured account name", () => {
    expect(
      providerDisplayLabel({
        instanceId: "claude_dj2",
        driver: claudeAgent,
        displayName: "Claude Max 5x",
      }),
    ).toBe("Claude Max 5x");
  });

  it("tells an unnamed second account apart from the default one", () => {
    expect(
      providerDisplayLabel({
        instanceId: "claude_dj2",
        driver: claudeAgent,
        displayName: "Claude",
      }),
    ).toBe("Claude Dj2");
    expect(
      providerDisplayLabel({
        instanceId: "claudeAgent",
        driver: claudeAgent,
        displayName: "Claude",
      }),
    ).toBe("Claude");
  });
});

describe("accountShorthand", () => {
  it("shortens account names to something that fits beside a model", () => {
    expect(accountShorthand("Claude Max 20x", claudeAgent)).toBe("20x");
    expect(accountShorthand("Claude Max 5x", claudeAgent)).toBe("5x");
    expect(accountShorthand("Personal", claudeAgent)).toBe("Personal");
    expect(accountShorthand("Claude Dj2", claudeAgent)).toBe("Dj2");
    expect(accountShorthand("Work Team Account", claudeAgent)).toBe("WTA");
    expect(accountShorthand("Claude", claudeAgent)).toBe("Claude");
  });
});

describe("modelOptionAccountBadge", () => {
  it("badges the account when two accounts offer the same model", () => {
    const options = buildModelOptions(
      makeConfig([
        { instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude Max 20x" },
        { instanceId: "claude_dj2", driver: "claudeAgent", displayName: "Claude Max 5x" },
      ]),
      null,
    );
    expect(options.map((option) => modelOptionAccountBadge(option, options))).toEqual([
      "20x",
      "5x",
    ]);
  });

  it("shows no badge when only one account exists", () => {
    const options = buildModelOptions(
      makeConfig([{ instanceId: "claudeAgent", driver: "claudeAgent" }]),
      null,
    );
    expect(modelOptionAccountBadge(options[0]!, options)).toBeNull();
  });
});

describe("resolveStartingModel", () => {
  // Codex signed in with ChatGPT no longer offers gpt-5.4; Claude offers Opus.
  const config = (settings: Record<string, unknown>) =>
    ({
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", isCustom: false, capabilities: null },
          ],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            { slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities: null },
          ],
        },
      ],
      settings: {
        defaultModelEnabled: false,
        defaultModelSelection: null,
        favorites: [],
        ...settings,
      },
    }) as unknown as ServerConfig;
  const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
  const retired = { instanceId: "codex", model: "gpt-5.4" } as never;

  it("starts on the default chosen in Settings, not the project's pinned model", () => {
    expect(
      resolveStartingModel(config({ defaultModelSelection: opus }), { projectDefault: retired }),
    ).toEqual(opus);
  });

  it("steps over a retired project model to a starred one", () => {
    expect(
      resolveStartingModel(
        config({ favorites: [{ provider: "claudeAgent", model: "claude-opus-5-5" }] }),
        {
          projectDefault: retired,
        },
      ),
    ).toEqual(opus);
  });

  it("follows the chat being continued unless the default is switched on", () => {
    const sol = { instanceId: "codex", model: "gpt-6.1-sol" } as never;
    expect(
      resolveStartingModel(config({ defaultModelSelection: opus }), { inherited: sol }),
    ).toEqual(sol);
    expect(
      resolveStartingModel(config({ defaultModelSelection: opus, defaultModelEnabled: true }), {
        inherited: sol,
      }),
    ).toEqual(opus);
  });
});
