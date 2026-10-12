import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ClientOrchestrationCommand,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const selection = {
  instanceId: ProviderInstanceId.make("claude-personal"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "high" }],
};
const create = Schema.decodeUnknownSync(ClientOrchestrationCommand)({
  type: "thread.create",
  commandId: "create-default",
  threadId: "thread-default",
  projectId: "project-default",
  title: "Default model",
  modelSelection: "default",
  runtimeMode: "approval-required",
  branch: null,
  worktreePath: null,
  createdAt: "2026-09-29T10:00:00.000Z",
});
const TestLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-default-model-" }),
  WorkspacePathsLive,
  ServerSettingsService.layerTest({ defaultModelEnabled: true, defaultModelSelection: selection }),
).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("resolves the API default token at creation and keeps explicit choices", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const first = yield* normalizeDispatchCommand(create);
      expect(first).toMatchObject({ modelSelection: selection });
      const replacement = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };
      yield* settings.updateSettings({ defaultModelSelection: replacement });
      expect(yield* normalizeDispatchCommand(create)).toMatchObject({
        modelSelection: replacement,
      });
      expect(first).toMatchObject({ modelSelection: selection });
      if (create.type !== "thread.create") throw new Error("Expected thread.create");
      expect(
        yield* normalizeDispatchCommand({ ...create, modelSelection: selection }),
      ).toMatchObject({ modelSelection: selection });
      // The switch only governs whether the default beats the chat someone is
      // in; an integration asking for "default" still gets it.
      yield* settings.updateSettings({ defaultModelEnabled: false });
      expect(yield* normalizeDispatchCommand(create)).toMatchObject({
        modelSelection: replacement,
      });
      yield* settings.updateSettings({ defaultModelSelection: null });
      const failure = yield* normalizeDispatchCommand(create).pipe(Effect.flip);
      expect(failure.message).toContain("Choose a default model");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

const provider = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<string>,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-09T10:00:00.000Z",
  models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  slashCommands: [],
  skills: [],
});

// The account the gpt-5.4 incident happened on: Codex signed in with ChatGPT,
// which no longer offers gpt-5.4, alongside Claude.
const connectedProviders = [
  provider("codex", "codex", ["gpt-6.1-sol", "gpt-6-astra"]),
  provider("claudeAgent", "claudeAgent", ["claude-opus-5-5"]),
];
const retiredDefault = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const layerWith = (settings: Parameters<typeof ServerSettingsService.layerTest>[0]) =>
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-default-model-" }),
    WorkspacePathsLive,
    ServerSettingsService.layerTest(settings),
    makeProviderRegistryLayer(connectedProviders),
  ).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("starts a 'default' thread on a starred model when the default cannot run", () =>
  Effect.scoped(
    Effect.gen(function* () {
      expect(yield* normalizeDispatchCommand(create)).toMatchObject({
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      });
    }),
  ).pipe(
    Effect.provide(
      layerWith({
        defaultModelEnabled: true,
        defaultModelSelection: retiredDefault,
        favorites: [
          { provider: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          { provider: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
        ],
      }),
    ),
  ),
);

it.effect("refuses a 'default' thread rather than start it on a model the account lacks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const failure = yield* normalizeDispatchCommand(create).pipe(Effect.flip);
      expect(failure.message).toContain("gpt-5.4");
      expect(failure.message).toContain("not available on the connected accounts");
    }),
  ).pipe(
    Effect.provide(layerWith({ defaultModelEnabled: true, defaultModelSelection: retiredDefault })),
  ),
);
