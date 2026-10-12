import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";
import { resolveNewThreadModelSelection } from "./newThreadModel";

const current = createModelSelection(ProviderInstanceId.make("claude-personal"), "claude-opus-5", [
  { id: "effort", value: "high" },
]);
const pending = createModelSelection(ProviderInstanceId.make("claude-work"), "claude-sonnet-5-5", [
  { id: "effort", value: "medium" },
]);
const configured = createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra");
const currentComposer = {
  activeProvider: pending.instanceId,
  modelSelectionByProvider: { [pending.instanceId]: pending },
};
const defaultOn = { defaultModelEnabled: true, defaultModelSelection: configured, favorites: [] };
const defaultOff = { ...defaultOn, defaultModelEnabled: false };
const noDefault = { defaultModelEnabled: false, defaultModelSelection: null, favorites: [] };

describe("new thread model", () => {
  it("uses the enabled default ahead of the current chat and pending composer", () => {
    expect(
      resolveNewThreadModelSelection({
        settings: defaultOn,
        currentThreadSelection: current,
        currentComposer,
      }),
    ).toEqual(configured);
  });

  it("inherits the current composer's account, model, and options when the default is off", () => {
    expect(
      resolveNewThreadModelSelection({
        settings: defaultOff,
        currentThreadSelection: current,
        currentComposer,
      }),
    ).toEqual(pending);
  });

  it("inherits the persisted chat when its composer has no selection", () => {
    expect(
      resolveNewThreadModelSelection({
        settings: noDefault,
        currentThreadSelection: current,
        currentComposer: { modelSelectionByProvider: {} },
      }),
    ).toEqual(current);
  });

  it("inherits a draft without a persisted thread", () => {
    expect(
      resolveNewThreadModelSelection({
        settings: noDefault,
        currentThreadSelection: null,
        currentComposer,
      }),
    ).toEqual(pending);
  });

  it("falls back to the saved default when the switch is off and there is no chat to inherit", () => {
    expect(
      resolveNewThreadModelSelection({
        settings: defaultOff,
        currentThreadSelection: null,
        currentComposer: null,
        projectDefault: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4"),
      }),
    ).toEqual(configured);
  });

  it("leaves the choice to the composer when nothing at all is known", () => {
    expect(
      resolveNewThreadModelSelection({
        settings: noDefault,
        currentThreadSelection: null,
        currentComposer: null,
      }),
    ).toBeNull();
  });
});

describe("new thread model checked against the connected accounts", () => {
  const offering = (instanceId: string, models: ReadonlyArray<string>) =>
    ({
      instanceId: ProviderInstanceId.make(instanceId),
      driver: instanceId,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-09T10:00:00.000Z",
      models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
      slashCommands: [],
      skills: [],
    }) as unknown as ServerProvider;
  const providers = [
    offering("codex", ["gpt-6.1-sol"]),
    offering("claudeAgent", ["claude-opus-5-5"]),
  ];
  const favorites = [
    { provider: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    { provider: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  ];
  const base = { currentThreadSelection: null, currentComposer: null, providers };

  it("starts on the first starred model the account can run", () => {
    expect(
      resolveNewThreadModelSelection({ ...base, settings: { ...noDefault, favorites } }),
    ).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5" });
  });

  it("steps over a project default the account cannot run", () => {
    expect(
      resolveNewThreadModelSelection({
        ...base,
        settings: { ...noDefault, favorites },
        projectDefault: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4"),
      }),
    ).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5" });
  });

  it("steps over a default the account can no longer run", () => {
    expect(
      resolveNewThreadModelSelection({
        ...base,
        settings: {
          defaultModelEnabled: true,
          defaultModelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4"),
          favorites,
        },
      }),
    ).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5" });
  });

  it("keeps a runnable project default when nothing else applies", () => {
    expect(
      resolveNewThreadModelSelection({
        ...base,
        settings: { ...noDefault, favorites },
        projectDefault: createModelSelection(ProviderInstanceId.make("codex"), "gpt-6.1-sol"),
      }),
    ).toEqual({ instanceId: "codex", model: "gpt-6.1-sol" });
  });
});
