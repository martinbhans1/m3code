import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeHttpServer } from "@effect/platform-node";
import { ThreadId, type AssetResource } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpRouter } from "effect/unstable/http";

import { issueAssetUrl } from "./assets/AssetAccess.ts";
import { resolveAttachmentRelativePath } from "./attachmentPaths.ts";
import { createAttachmentId } from "./attachmentStore.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { ServerConfig } from "./config.ts";
import { assetResponseHeaders, assetRouteLayer } from "./http.ts";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";

const SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups";

describe("assetResponseHeaders", () => {
  it("serves attachment-store files inside a sandboxed, opaque origin", () => {
    for (const path of ["/store/page.html", "/store/PAGE.HTM", "/store/x.xhtml", "/store/x.svg"]) {
      const headers = assetResponseHeaders({ path, sandboxed: true });
      expect(headers["Content-Security-Policy"], path).toBe(SANDBOX_CSP);
      expect(headers["X-Content-Type-Options"], path).toBe("nosniff");
    }
    expect(
      assetResponseHeaders({ path: "/store/page.html", sandboxed: true })["Content-Type"],
    ).toBe("text/html; charset=utf-8");
  });

  it("never grants same-origin or modals", () => {
    const policy = assetResponseHeaders({ path: "page.html", sandboxed: true })[
      "Content-Security-Policy"
    ];
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).not.toContain("allow-modals");
  });

  it("leaves the user's own project files exactly as before", () => {
    for (const path of ["/workspace/index.html", "/workspace/logo.svg", "/workspace/shot.png"]) {
      expect(assetResponseHeaders({ path, sandboxed: false }), path).toEqual({
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      });
    }
  });
});

const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-asset-route-test-" });
const servicesLayer = Layer.mergeAll(
  configLayer,
  WorkspacePathsLive,
  ProjectFaviconResolverLive.pipe(Layer.provide(WorkspacePathsLive)),
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer));

const fetchAsset = (resource: AssetResource, workspaceRoot?: string) =>
  Effect.gen(function* () {
    const { relativeUrl } = yield* issueAssetUrl({
      resource,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    });
    return yield* (yield* HttpClient.HttpClient).get(relativeUrl);
  });

const serveAssets = HttpRouter.serve(assetRouteLayer, {
  disableListenLog: true,
  disableLogger: true,
}).pipe(Layer.build);

const writeAttachment = (threadId: string, extension: string, contents: string) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
    const attachmentId = createAttachmentId(threadId)!;
    const filePath = resolveAttachmentRelativePath({
      attachmentsDir: config.attachmentsDir,
      relativePath: `${attachmentId}${extension}`,
    })!;
    yield* fileSystem.writeFileString(filePath, contents);
    return { attachmentId, filePath };
  });

it.effect("serves an html_render page with the sandbox policy over real HTTP", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { attachmentId } = yield* writeAttachment("thread-asset-route", ".html", "<p>page</p>");
      yield* serveAssets;
      const response = yield* fetchAsset({ _tag: "attachment", attachmentId });

      expect(response.status).toBe(200);
      expect(response.headers["content-security-policy"]).toBe(SANDBOX_CSP);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(yield* response.text).toBe("<p>page</p>");
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, servicesLayer))),
);

it.effect("sandboxes every attachment, whatever its extension", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serveAssets;
      for (const extension of [".svg", ".xhtml", ".xml", ".png", ".pdf"]) {
        const { attachmentId } = yield* writeAttachment(
          "thread-asset-route-ext",
          extension,
          "<html><script>1</script></html>",
        );
        const response = yield* fetchAsset({ _tag: "attachment", attachmentId });
        expect(response.status, extension).toBe(200);
        expect(response.headers["content-security-policy"], extension).toBe(SANDBOX_CSP);
        expect(response.headers["x-content-type-options"], extension).toBe("nosniff");
      }
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, servicesLayer))),
);

it.effect("serves an html_render page reached through a workspace URL with the sandbox", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      const { filePath } = yield* writeAttachment("thread-asset-route-ws", ".html", "<p>x</p>");
      yield* serveAssets;
      const response = yield* fetchAsset(
        { _tag: "workspace-file", threadId: ThreadId.make("thread-1"), path: filePath },
        path.dirname(config.attachmentsDir),
      );
      expect(response.status).toBe(200);
      expect(response.headers["content-security-policy"]).toBe(SANDBOX_CSP);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, servicesLayer))),
);

it.effect("serves the user's own project HTML without a sandbox", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-asset-route-ws-" });
      const htmlPath = path.join(root, "index.html");
      yield* fileSystem.writeFileString(htmlPath, "<p>project</p>");
      yield* serveAssets;
      const response = yield* fetchAsset(
        { _tag: "workspace-file", threadId: ThreadId.make("thread-1"), path: htmlPath },
        root,
      );

      expect(response.status).toBe(200);
      expect(response.headers["content-security-policy"]).toBeUndefined();
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["cache-control"]).toBe("private, max-age=3600");
      expect(yield* response.text).toBe("<p>project</p>");
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, servicesLayer))),
);
