// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";
import { type ModelSelection, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import {
  describeModelFallback,
  listOrchestratorModelChoices,
  resolveModelSelection,
  resolveNewConversationModel,
  type RunnableModel,
} from "./modelResolution.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

const runnable: ReadonlyArray<RunnableModel> = [
  { instanceId: codex, slug: "gpt-6.1-sol" },
  { instanceId: codex, slug: "gpt-6-astra" },
  { instanceId: claude, slug: "claude-opus-5-5" },
  { instanceId: claude, slug: "claude-sonnet-5-5" },
];
const toSelection = (model: RunnableModel): ModelSelection => ({
  instanceId: model.instanceId,
  model: model.slug,
});
const select = (instanceId: ProviderInstanceId, model: string): ModelSelection => ({
  instanceId,
  model,
});

// The record this whole module exists for: projects created while the code
// constant was gpt-5.4 still carry it, and the ChatGPT-backed Codex account
// refuses it with a provider 400.
const retiredProjectDefault = select(codex, "gpt-5.4");

describe("resolveModelSelection", () => {
  it("prefers the configured default over a project's stored default", () => {
    const resolution = resolveModelSelection({
      runnable,
      configuredDefault: select(claude, "claude-opus-5-5"),
      projectDefault: select(codex, "gpt-6-astra"),
      toSelection,
    });
    expect(resolution).toMatchObject({
      outcome: "resolved",
      source: "default",
      selection: { model: "claude-opus-5-5" },
      verified: true,
      skipped: [],
    });
  });

  it("keeps an explicit choice ahead of every default", () => {
    const resolution = resolveModelSelection({
      runnable,
      explicit: select(codex, "gpt-6-astra"),
      configuredDefault: select(claude, "claude-opus-5-5"),
      toSelection,
    });
    expect(resolution).toMatchObject({ source: "explicit", selection: { model: "gpt-6-astra" } });
  });

  it("steps over a retired project default to a starred model, and says so", () => {
    const resolution = resolveModelSelection({
      runnable,
      projectDefault: retiredProjectDefault,
      favorites: [
        { provider: claude, model: "claude-fable-9" }, // stale star: offered by nobody
        { provider: claude, model: "claude-opus-5-5" },
      ],
      toSelection,
    });
    expect(resolution).toMatchObject({
      outcome: "resolved",
      source: "favorite",
      selection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    });
    expect(resolution.skipped.map((candidate) => candidate.selection.model)).toEqual(["gpt-5.4"]);
    expect(describeModelFallback(resolution)).toContain("gpt-5.4 is not available");
  });

  it("falls back to any runnable model only when nothing preferred applies", () => {
    const resolution = resolveModelSelection({
      runnable,
      projectDefault: retiredProjectDefault,
      toSelection,
    });
    expect(resolution).toMatchObject({ source: "available", selection: { model: "gpt-6.1-sol" } });
  });

  it("fails with a usable message instead of choosing a model no account offers", () => {
    const resolution = resolveModelSelection({
      runnable: [],
      toSelection,
    });
    expect(resolution.outcome).toBe("unsupported");
    expect(describeModelFallback(resolution)).toContain("No provider is offering a model");
  });

  it("treats an empty provider list as unknown, not as nothing runnable", () => {
    // A provider-status timeout must not block thread creation, but the
    // result must not claim it was checked either.
    const resolution = resolveModelSelection({
      runnable: [],
      projectDefault: retiredProjectDefault,
      toSelection,
    });
    expect(resolution).toMatchObject({
      outcome: "resolved",
      source: "project",
      verified: false,
    });
  });
});

describe("listOrchestratorModelChoices", () => {
  const favorites = [
    { provider: claude, model: "claude-opus-5-5" },
    { provider: codex, model: "gpt-6.1-sol" },
    { provider: codex, model: "gpt-5.4" },
  ];
  const customChoices = [select(claude, "claude-opus-5"), select(codex, "gpt-6-astra")];

  it("offers the starred models the accounts can run, in the user's order", () => {
    expect(
      listOrchestratorModelChoices({
        source: "favorites",
        favorites,
        customChoices,
        runnable,
        toSelection,
      }).map((choice) => choice.model),
    ).toEqual(["claude-opus-5-5", "gpt-6.1-sol"]);
  });

  it("keeps the explicit list working when switched to custom", () => {
    expect(
      listOrchestratorModelChoices({
        source: "custom",
        favorites,
        customChoices,
        runnable,
        toSelection,
      }).map((choice) => choice.model),
    ).toEqual(["gpt-6-astra"]);
  });

  it("keeps every star while availability is unknown", () => {
    expect(
      listOrchestratorModelChoices({
        source: "favorites",
        favorites,
        customChoices,
        runnable: [],
        toSelection,
      }),
    ).toHaveLength(3);
  });
});

describe("new-project entry points", () => {
  // Every one of these once wrote `{ instanceId: "codex", model: DEFAULT_MODEL }`
  // into the project record, which is how a retired model outlived the
  // constant by months. A project should be created without a pinned model.
  const entryPoints = [
    "../../client-runtime/src/addProject.ts",
    "../../../apps/web/src/components/CommandPalette.tsx",
    "../../../apps/server/src/cli/project.ts",
    "../../../apps/server/src/serverRuntimeStartup.ts",
  ];

  it.each(entryPoints)("%s does not pin a code-constant model", (relativePath) => {
    const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
    expect(source).not.toMatch(/\bDEFAULT_MODEL\b/);
  });
});

describe("resolveNewConversationModel", () => {
  const providers = [
    {
      instanceId: codex,
      driver: "codex",
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models: [{ slug: "gpt-6.1-sol" }],
    },
    {
      instanceId: claude,
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models: [{ slug: "claude-opus-5-5" }],
    },
    {
      // Signed out: what it lists is not something a conversation can start on.
      instanceId: ProviderInstanceId.make("grok"),
      driver: "grok",
      enabled: true,
      installed: true,
      auth: { status: "unauthenticated" },
      models: [{ slug: "grok-4.6" }],
    },
  ] as unknown as ReadonlyArray<ServerProvider>;
  const opus = select(claude, "claude-opus-5-5");
  const sol = select(codex, "gpt-6.1-sol");

  it("uses the saved default with the switch off when there is no chat to follow", () => {
    expect(
      resolveNewConversationModel({
        settings: { defaultModelEnabled: false, defaultModelSelection: opus, favorites: [] },
        providers,
        projectDefault: retiredProjectDefault,
      }),
    ).toMatchObject({ source: "default", selection: opus });
  });

  it("lets the chat being continued win only while the switch is off", () => {
    const settings = { defaultModelSelection: opus, favorites: [] };
    expect(
      resolveNewConversationModel({
        settings: { ...settings, defaultModelEnabled: false },
        providers,
        inherited: sol,
      }),
    ).toMatchObject({ source: "inherited", selection: sol });
    expect(
      resolveNewConversationModel({
        settings: { ...settings, defaultModelEnabled: true },
        providers,
        inherited: sol,
      }),
    ).toMatchObject({ source: "default", selection: opus });
  });

  it("never picks a model from a signed-out account", () => {
    expect(
      resolveNewConversationModel({
        settings: {
          defaultModelEnabled: true,
          defaultModelSelection: select(ProviderInstanceId.make("grok"), "grok-4.6"),
          favorites: [],
        },
        providers,
      }),
    ).toMatchObject({ source: "available", selection: sol });
  });

  // The phone opened a new chat before its settings and model list arrived,
  // and started it on the project's pinned gpt-5.4, which the account rejects.
  it("refuses to choose before the settings have loaded", () => {
    expect(
      resolveNewConversationModel({
        settings: null,
        providers: [],
        projectDefault: retiredProjectDefault,
      }),
    ).toMatchObject({ outcome: "unsupported" });
  });

  it("never falls back to the project's pinned model while the model list is unknown", () => {
    expect(
      resolveNewConversationModel({
        settings: { defaultModelEnabled: false, defaultModelSelection: null, favorites: [] },
        providers: [],
        projectDefault: retiredProjectDefault,
      }),
    ).toMatchObject({ outcome: "unsupported" });
    expect(
      resolveNewConversationModel({
        settings: { defaultModelEnabled: false, defaultModelSelection: opus, favorites: [] },
        providers: [],
        projectDefault: retiredProjectDefault,
      }),
    ).toMatchObject({ source: "default", selection: opus, verified: false });
  });
});
