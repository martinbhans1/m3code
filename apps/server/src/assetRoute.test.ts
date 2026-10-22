import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpRouter } from "effect/unstable/http";

import { issueAssetUrl } from "./assets/AssetAccess.ts";
import { resolveAttachmentRelativePath } from "./attachmentPaths.ts";
import { createAttachmentId } from "./attachmentStore.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { ServerConfig } from "./config.ts";
import { assetResponseHeaders, assetRouteLayer } from "./http.ts";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";

const HTML_CSP = "sandbox allow-scripts allow-forms allow-popups";

describe("assetResponseHeaders", () => {
  it("serves HTML as utf-8 inside a sandboxed, opaque origin", () => {
    for (const path of ["/workspace/page.html", "/workspace/PAGE.HTM", "C:a\b.xhtml"]) {
      const headers = assetResponseHeaders(path);
      expect(headers["Content-Security-Policy"], path).toBe(HTML_CSP);
      expect(headers["X-Content-Type-Options"], path).toBe("nosniff");
      expect(headers["Content-Type"], path).toBe("text/html; charset=utf-8");
    }
  });

  it("never grants same-origin or modals to HTML", () => {
    const policy = assetResponseHeaders("page.html")["Content-Security-Policy"];
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).not.toContain("allow-modals");
  });

  it("locks SVG documents down and leaves other files alone", () => {
    expect(assetResponseHeaders("logo.svg")["Content-Security-Policy"]).toContain("sandbox");
    const png = assetResponseHeaders("shot.png");
    expect(png["Content-Security-Policy"]).toBeUndefined();
    expect(png["Content-Type"]).toBeUndefined();
    expect(png["X-Content-Type-Options"]).toBe("nosniff");
  });
});

const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-asset-route-test-" });
const servicesLayer = Layer.mergeAll(
  configLayer,
  WorkspacePathsLive,
  ProjectFaviconResolverLive.pipe(Layer.provide(WorkspacePathsLive)),
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("serves a stored HTML page with the sandbox policy over real HTTP", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const attachmentId = createAttachmentId("thread-asset-route")!;
      const filePath = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: `${attachmentId}.html`,
      })!;
      yield* (yield* FileSystem.FileSystem).writeFileString(filePath, "<p>page</p>");

      const { relativeUrl } = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId },
      });
      yield* HttpRouter.serve(assetRouteLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const response = yield* (yield* HttpClient.HttpClient).get(relativeUrl);

      expect(response.status).toBe(200);
      expect(response.headers["content-security-policy"]).toBe(HTML_CSP);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(yield* response.text).toBe("<p>page</p>");
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, servicesLayer))),
);
