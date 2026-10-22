import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HTML_RENDER_MAX_BYTES } from "@t3tools/shared/htmlRender";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { resolveAttachmentPathById } from "../../../attachmentStore.ts";
import { ServerConfig } from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { HtmlRenderToolkitHandlersLive } from "./handlers.ts";
import { HtmlRenderToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread-html-render");

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "html-render-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-html-render-test"),
  threadId,
  providerSessionId: "provider-session-html-render-test",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
};

const TestLayer = McpServer.toolkit(HtmlRenderToolkit).pipe(
  Layer.provide(HtmlRenderToolkitHandlersLive),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-html-render-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const callTool = (args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "html_render", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("stores the page as an attachment of the calling thread, with the bootstrap", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* callTool({
        html: "<!doctype html><html><head><title>Chart</title></head><body><p>Hi</p></body></html>",
        title: "  Revenue chart  ",
        height: 5000,
      });
      expect(result.isError).toBe(false);
      const { htmlRender } = result.structuredContent as {
        htmlRender: { attachmentId: string; title: string; height?: number };
      };
      expect(htmlRender.title).toBe("Revenue chart");
      // Clamped to the most a frame may take.
      expect(htmlRender.height).toBe(2000);
      expect(htmlRender.attachmentId.startsWith("thread-html-render-")).toBe(true);

      const config = yield* ServerConfig;
      const filePath = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: htmlRender.attachmentId,
      });
      expect(filePath?.endsWith(".html")).toBe(true);
      const stored = yield* (yield* FileSystem.FileSystem).readFileString(filePath!);
      expect(stored).toContain('<style id="t3-theme">');
      expect(stored).toContain("<p>Hi</p>");
      // The bootstrap goes inside the page's own head, before its title.
      expect(stored.indexOf('id="t3-theme"')).toBeLessThan(stored.indexOf("<title>"));
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses a page over the size limit without writing anything", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const before = yield* fileSystem.readDirectory(config.attachmentsDir);

      // Multi-byte characters: under the limit in characters, over it in bytes.
      const html = `<p>${"é".repeat(HTML_RENDER_MAX_BYTES / 2 + 1)}</p>`;
      const result = yield* callTool({ html, title: "Too big" });

      expect(result.isError).toBe(true);
      const text = result.content.map((block) => ("text" in block ? block.text : "")).join("");
      expect(text).toContain("the limit is 512 KB");
      expect(yield* fileSystem.readDirectory(config.attachmentsDir)).toEqual(before);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses an empty page or title", () =>
  Effect.scoped(
    Effect.gen(function* () {
      expect((yield* callTool({ html: "   ", title: "Empty" })).isError).toBe(true);
      expect((yield* callTool({ html: "<p>x</p>", title: "  " })).isError).toBe(true);
    }),
  ).pipe(Effect.provide(TestLayer)),
);
