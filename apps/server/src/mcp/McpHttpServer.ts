import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { FollowupToolkitHandlersLive } from "./toolkits/followup/handlers.ts";
import { FollowupToolkit } from "./toolkits/followup/tools.ts";
import { OrchestratorToolkitHandlersLive } from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid provider-scoped MCP bearer credential is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

const forbidden = HttpServerResponse.jsonUnsafe(
  {
    error: "insufficient_mcp_capability",
    message:
      "This thread's MCP credential does not grant the orchestrator capability. Cross-thread tools are limited to the project designated in settings.",
  },
  {
    status: 403,
    headers: { "cache-control": "no-store" },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

const makeMcpAuthMiddleware = (
  requiredCapability?: McpInvocationContext.McpCapability,
): Effect.Effect<McpAuthMiddleware, never, McpSessionRegistry.McpSessionRegistry> =>
  McpSessionRegistry.McpSessionRegistry.pipe(
    Effect.map(
      (registry): McpAuthMiddleware =>
        Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const authorization = request.headers.authorization;
          const token =
            authorization?.startsWith("Bearer ") === true
              ? authorization.slice("Bearer ".length).trim()
              : "";
          const invocation = yield* registry.resolve(token);
          if (!invocation) return unauthorized;
          // The orchestrator mount is rejected here, before any MCP handshake,
          // so a thread without the capability cannot even enumerate the
          // cross-thread tools.
          if (requiredCapability && !invocation.capabilities.has(requiredCapability)) {
            return forbidden;
          }
          return yield* httpEffect.pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.map(normalizeMcpHttpResponse),
          );
        }),
    ),
    Effect.withSpan("McpHttpServer.makeAuthMiddleware"),
  );

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware()).layer;

const McpOrchestratorAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware("orchestrator")).layer;

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const built = yield* PreviewSnapshotToolkit;
  const tool = PreviewSnapshotTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built.handle("preview_snapshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.matchCause({
            onFailure: (cause) =>
              new McpSchema.CallToolResult({
                isError: true,
                content: [{ type: "text", text: Cause.pretty(cause) }],
              }),
            onSuccess: ({ encodedResult }) => {
              const snapshot = encodedResult as {
                readonly screenshot: {
                  readonly mimeType: "image/png";
                  readonly data: string;
                  readonly width: number;
                  readonly height: number;
                };
                readonly [key: string]: unknown;
              };
              const { screenshot, ...page } = snapshot;
              const metadata = {
                ...page,
                screenshot: {
                  mimeType: screenshot.mimeType,
                  width: screenshot.width,
                  height: screenshot.height,
                },
              };
              return new McpSchema.CallToolResult({
                isError: false,
                structuredContent: metadata,
                content: [
                  { type: "text", text: JSON.stringify(metadata) },
                  {
                    type: "image",
                    data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                    mimeType: screenshot.mimeType,
                  },
                ],
              });
            },
          }),
        );
      }),
  });
});

const PreviewStandardToolkitRegistrationLive = McpServer.toolkit(PreviewStandardToolkit).pipe(
  Layer.provide(PreviewStandardToolkitHandlersLive),
);

const PreviewSnapshotRegistrationLive = Layer.effectDiscard(registerPreviewSnapshot()).pipe(
  Layer.provide(PreviewSnapshotToolkitHandlersLive),
);

const FollowupToolkitRegistrationLive = McpServer.toolkit(FollowupToolkit).pipe(
  Layer.provide(FollowupToolkitHandlersLive),
);

export const PreviewToolkitRegistrationLive = Layer.mergeAll(
  PreviewStandardToolkitRegistrationLive,
  PreviewSnapshotRegistrationLive,
  FollowupToolkitRegistrationLive,
);

const McpTransportLive = McpServer.layerHttp({
  name: "M3 Code",
  version: packageJson.version,
  path: McpSessionRegistry.MCP_PATH,
}).pipe(Layer.provide(McpAuthMiddlewareLive));

const SharedMcpServerLive = PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpTransportLive),
  Layer.provide(PreviewAutomationBroker.layer),
);

// A second, separately-mounted MCP server. It exists because MCP can only
// filter `tools/list` by client identity, which is identical for every thread
// here — so the only way to keep cross-thread tools out of ordinary threads'
// tool lists (and their token budget) is to serve them from a route those
// threads are never given.
const McpOrchestratorTransportLive = McpServer.layerHttp({
  name: "M3 Code Orchestrator",
  version: packageJson.version,
  path: McpSessionRegistry.MCP_ORCHESTRATOR_PATH,
}).pipe(Layer.provide(McpOrchestratorAuthMiddlewareLive));

// `Layer.fresh` around the whole subtree is load-bearing, not hygiene.
// `McpServer.layerHttp` is built on one module-level `McpServer.layer`, which
// Effect memoizes — so in a shared memo map both mounts resolve to the same
// tool registry and every orchestrator tool also shows up on `/mcp`. The fresh
// boundary must wrap the transport *and* the toolkit registration together, so
// that inside it they agree on one second instance. See the route-isolation
// test, which fails both ways this can be got wrong.
const OrchestratorMcpServerLive = Layer.fresh(
  McpServer.toolkit(OrchestratorToolkit).pipe(
    Layer.provide(OrchestratorToolkitHandlersLive),
    Layer.provideMerge(McpOrchestratorTransportLive),
  ),
);

export const layer = Layer.mergeAll(SharedMcpServerLive, OrchestratorMcpServerLive);
