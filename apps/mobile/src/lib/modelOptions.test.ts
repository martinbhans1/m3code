import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind, type ServerConfig } from "@t3tools/contracts";

import { buildModelOptions, describeModelOption, providerDisplayLabel } from "./modelOptions";

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

describe("describeModelOption", () => {
  it("names the account when two accounts offer the same model", () => {
    const options = buildModelOptions(
      makeConfig([
        { instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude Max 20x" },
        { instanceId: "claude_dj2", driver: "claudeAgent", displayName: "Claude Max 5x" },
      ]),
      null,
    );
    expect(options.map((option) => describeModelOption(option, options))).toEqual([
      "Opus 5.5 · Claude Max 20x",
      "Opus 5.5 · Claude Max 5x",
    ]);
  });

  it("keeps the bare model name when only one account exists", () => {
    const options = buildModelOptions(
      makeConfig([{ instanceId: "claudeAgent", driver: "claudeAgent" }]),
      null,
    );
    expect(describeModelOption(options[0]!, options)).toBe("Opus 5.5");
  });
});
