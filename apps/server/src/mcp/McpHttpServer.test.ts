import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import { EnvironmentId, PreviewTabId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { CheckpointDiffQuery } from "../checkpointing/Services/CheckpointDiffQuery.ts";
import { ConversationSearch } from "../conversationSearch/ConversationSearch.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
);

// ── Route isolation ──────────────────────────────────────────────────
//
// The orchestrator toolkit is mounted on its own route precisely so ordinary
// threads never see its tools. That is a claim about HTTP wiring, so it is
// tested over real HTTP rather than against the toolkit in isolation.

const ORCHESTRATOR_TOKEN = "orchestrator-token";
const ORDINARY_TOKEN = "ordinary-token";

const scopeForToken = (token: string): McpInvocationContext.McpInvocationScope | undefined => {
  if (token === ORCHESTRATOR_TOKEN) {
    return { ...invocation, capabilities: new Set(["preview", "orchestrator"] as const) };
  }
  if (token === ORDINARY_TOKEN) return invocation;
  return undefined;
};

const StubRegistryLive = Layer.succeed(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.McpSessionRegistry.of({
    issue: () => Effect.die("unused"),
    resolve: (rawToken: string) => Effect.succeed(scopeForToken(rawToken)),
    revokeProviderSession: () => Effect.void,
    revokeThread: () => Effect.void,
    revokeAll: Effect.void,
  }),
);

const emptySnapshot = {
  snapshotSequence: 0,
  projects: [],
  threads: [],
  updatedAt: "2026-08-05T09:00:00.000Z",
};

const OrchestratorStubServicesLive = Layer.mergeAll(
  Layer.succeed(
    ProjectionSnapshotQuery,
    ProjectionSnapshotQuery.of({
      getShellSnapshot: () => Effect.succeed(emptySnapshot),
      getArchivedShellSnapshot: () => Effect.succeed(emptySnapshot),
      getThreadShellById: () => Effect.succeed(Option.none()),
      getThreadDetailById: () => Effect.succeed(Option.none()),
      getProjectShellById: () => Effect.succeed(Option.none()),
    } as unknown as ProjectionSnapshotQuery["Service"]),
  ),
  Layer.succeed(
    ConversationSearch,
    ConversationSearch.of({
      search: () => Effect.succeed({ results: [], semanticStatus: "ready" }),
    } as unknown as ConversationSearch["Service"]),
  ),
  Layer.succeed(
    OrchestrationEngineService,
    OrchestrationEngineService.of({
      dispatch: () => Effect.succeed({ sequence: 1 }),
    } as unknown as OrchestrationEngineService["Service"]),
  ),
  Layer.succeed(
    ServerRuntimeStartup,
    ServerRuntimeStartup.of({
      enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) => effect,
    } as unknown as ServerRuntimeStartup["Service"]),
  ),
  Layer.succeed(
    CheckpointDiffQuery,
    CheckpointDiffQuery.of({
      getTurnDiff: () => Effect.die("unused"),
      getFullThreadDiff: () => Effect.die("unused"),
    } as unknown as CheckpointDiffQuery["Service"]),
  ),
);

const ToolListResponse = Schema.Struct({
  result: Schema.optional(
    Schema.Struct({
      tools: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
    }),
  ),
});
const decodeToolListResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(ToolListResponse));

const initializeBody = HttpBody.text(
  `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
  "application/json",
);

const listToolNames = (path: string, token: string) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const initialize = yield* httpClient.post(path, {
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: initializeBody,
    });
    expect(initialize.status).toBe(200);
    const sessionId = initialize.headers["mcp-session-id"];

    const listed = yield* httpClient.post(path, {
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: HttpBody.text(
        `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
        "application/json",
      ),
    });
    // Streamable HTTP may answer as an SSE frame; take the data line when it does.
    const text = yield* listed.text;
    const payload = yield* decodeToolListResponse(text.replace(/^event:.*\ndata: /m, ""));
    return (payload.result?.tools ?? []).map((tool) => tool.name);
  });

it.effect(
  "serves cross-thread tools only on the orchestrator route, and only to capable threads",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* HttpRouter.serve(McpHttpServer.layer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);
        const httpClient = yield* HttpClient.HttpClient;

        // Both routes exist and both demand a credential.
        for (const path of [
          McpSessionRegistry.MCP_PATH,
          McpSessionRegistry.MCP_ORCHESTRATOR_PATH,
        ]) {
          const anonymous = yield* httpClient.post(path, {
            headers: { accept: "application/json, text/event-stream" },
            body: initializeBody,
          });
          expect(anonymous.status, `${path} must reject anonymous callers`).toBe(401);
        }

        // A thread without the capability is turned away before the handshake,
        // so it cannot even enumerate the cross-thread tools.
        const uncapable = yield* httpClient.post(McpSessionRegistry.MCP_ORCHESTRATOR_PATH, {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${ORDINARY_TOKEN}`,
          },
          body: initializeBody,
        });
        expect(uncapable.status).toBe(403);

        // The shared route carries the preview/follow-up tools and nothing else.
        const sharedTools = yield* listToolNames(McpSessionRegistry.MCP_PATH, ORDINARY_TOKEN);
        expect(sharedTools).toContain("preview_status");
        expect(sharedTools).toContain("suggest_followup");
        // The in-thread half of the follow-up deck: a conversation can read back
        // and close its own chips without seeing anyone else's.
        expect(sharedTools).toContain("list_followups");
        expect(sharedTools).toContain("resolve_followup");
        for (const name of [
          "list_threads",
          "search_threads",
          "read_thread",
          "list_pending",
          "send_to_thread",
        ]) {
          expect(sharedTools, `${name} must not leak onto the shared route`).not.toContain(name);
        }

        // The orchestrator route carries exactly the cross-thread tools.
        const orchestratorTools = yield* listToolNames(
          McpSessionRegistry.MCP_ORCHESTRATOR_PATH,
          ORCHESTRATOR_TOKEN,
        );
        expect(orchestratorTools.toSorted()).toEqual([
          "answer_thread_question",
          "create_thread",
          "list_pending",
          "list_threads",
          "read_thread",
          "read_thread_changes",
          "resolve_followup",
          "search_threads",
          "send_to_thread",
        ]);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeHttpServer.layerTest,
          StubRegistryLive,
          OrchestratorStubServicesLive,
          NodeServices.layer,
        ),
      ),
    ),
);

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const requests = yield* broker.connect("mcp-test-client");
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          requestId: request.requestId,
          ok: true,
          result:
            request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                    width: 10,
                    height: 5,
                  },
                }
              : request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* broker.reportOwner({
        clientId: "mcp-test-client",
        environmentId,
        threadId,
        tabId,
        visible: true,
        supportsAutomation: true,
        focusedAt: "2026-06-11T00:00:00.000Z",
      });

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(malformed.isError).toBe(true);

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });

      const press = yield* server
        .callTool({ name: "preview_press", arguments: { key: "Enter" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(press.isError).toBe(false);
      expect(press.structuredContent).toBeNull();
      expect(press.content).toEqual([{ type: "text", text: "null" }]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);
