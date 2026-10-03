import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ClientOrchestrationCommand, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
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
      yield* settings.updateSettings({ defaultModelEnabled: false });
      const failure = yield* normalizeDispatchCommand(create).pipe(Effect.flip);
      expect(failure.message).toContain("Choose and enable a default model");
    }),
  ).pipe(Effect.provide(TestLayer)),
);
