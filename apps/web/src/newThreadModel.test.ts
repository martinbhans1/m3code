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

describe("new thread model", () => {
  it("uses the enabled default ahead of the current chat and pending composer", () => {
    expect(
      resolveNewThreadModelSelection({
        defaultSelection: configured,
        currentThreadSelection: current,
        currentComposer,
      }),
    ).toEqual(configured);
  });

  it("inherits the current composer's account, model, and options when the default is off", () => {
    expect(
      resolveNewThreadModelSelection({
        defaultSelection: null,
        currentThreadSelection: current,
        currentComposer,
      }),
    ).toEqual(pending);
  });

  it("inherits the persisted chat when its composer has no selection", () => {
    expect(
      resolveNewThreadModelSelection({
        defaultSelection: null,
        currentThreadSelection: current,
        currentComposer: { modelSelectionByProvider: {} },
      }),
    ).toEqual(current);
  });

  it("inherits a draft without a persisted thread", () => {
    expect(
      resolveNewThreadModelSelection({
        defaultSelection: null,
        currentThreadSelection: null,
        currentComposer,
      }),
    ).toEqual(pending);
  });

  it("leaves the normal fallback in place when there is no current chat or default", () => {
    expect(
      resolveNewThreadModelSelection({
        defaultSelection: null,
        currentThreadSelection: null,
        currentComposer: null,
      }),
    ).toBeNull();
  });
});

describe("new thread model with nothing to inherit", () => {
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
  const base = { defaultSelection: null, currentThreadSelection: null, currentComposer: null };

  it("starts on the first starred model the account can run", () => {
    expect(resolveNewThreadModelSelection({ ...base, favorites, providers })).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });

  it("steps over a project default the account cannot run", () => {
    expect(
      resolveNewThreadModelSelection({
        ...base,
        projectDefault: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4"),
        favorites,
        providers,
      }),
    ).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5" });
  });

  it("leaves a runnable project default in charge", () => {
    expect(
      resolveNewThreadModelSelection({
        ...base,
        projectDefault: createModelSelection(ProviderInstanceId.make("codex"), "gpt-6.1-sol"),
        favorites,
        providers,
      }),
    ).toBeNull();
  });
});
