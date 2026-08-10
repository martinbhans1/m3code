import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServer } from "effect/unstable/http";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const orchestratorProjectId = ProjectId.make("project-orchestrator");
const ordinaryProjectId = ProjectId.make("project-dealjourney");

const fakeHttpServer = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});
const fakeEnvironment = ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const threadShell = (threadId: ThreadId, projectId: ProjectId): OrchestrationThreadShell =>
  ({ id: threadId, projectId }) as unknown as OrchestrationThreadShell;

/**
 * Only `getThreadShellById` is exercised by credential issuance; everything
 * else dies loudly so a future dependency cannot slip in untested.
 */
const fakeSnapshotQuery = (threadProjects: ReadonlyMap<string, ProjectId>) =>
  ProjectionSnapshotQuery.of({
    getThreadShellById: (threadId: ThreadId) => {
      const projectId = threadProjects.get(threadId);
      return Effect.succeed(
        projectId === undefined ? Option.none() : Option.some(threadShell(threadId, projectId)),
      );
    },
  } as unknown as ProjectionSnapshotQuery["Service"]);

const makeRegistry = (
  now: () => number,
  options: {
    readonly orchestratorProject?: ProjectId | null;
    readonly threadProjects?: ReadonlyMap<string, ProjectId>;
  } = {},
) =>
  McpSessionRegistry.__testing
    .make({
      now,
      idleTimeoutMs: 100,
      maximumLifetimeMs: 1_000,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
      Effect.provideService(ServerEnvironment, fakeEnvironment),
      Effect.provideService(
        ProjectionSnapshotQuery,
        fakeSnapshotQuery(options.threadProjects ?? new Map()),
      ),
      Effect.provideService(
        ServerSettingsService,
        ServerSettingsService.of({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            orchestratorProjectId: options.orchestratorProject ?? null,
          }),
        } as unknown as ServerSettingsService["Service"]),
      ),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("withholds the orchestrator capability when no orchestrator project is designated", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-meta");
    const registry = yield* makeRegistry(() => 1_000, {
      orchestratorProject: null,
      threadProjects: new Map([[threadId, orchestratorProjectId]]),
    });
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
    expect(issued.config.orchestratorEndpoint).toBeNull();

    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);
    expect(resolved?.capabilities.has("orchestrator")).toBe(false);
    expect(resolved?.capabilities.has("preview")).toBe(true);
  }),
);

it.effect("withholds the orchestrator capability from threads outside that project", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-dealjourney");
    const registry = yield* makeRegistry(() => 1_000, {
      orchestratorProject: orchestratorProjectId,
      threadProjects: new Map([[threadId, ordinaryProjectId]]),
    });
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
    expect(issued.config.orchestratorEndpoint).toBeNull();

    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect((yield* registry.resolve(token))?.capabilities.has("orchestrator")).toBe(false);
  }),
);

it.effect("grants the orchestrator capability to threads inside the designated project", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-meta");
    const registry = yield* makeRegistry(() => 1_000, {
      orchestratorProject: orchestratorProjectId,
      threadProjects: new Map([[threadId, orchestratorProjectId]]),
    });
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
    expect(issued.config.orchestratorEndpoint).toBe("http://127.0.0.1:43123/mcp-orchestrator");

    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect((yield* registry.resolve(token))?.capabilities.has("orchestrator")).toBe(true);
  }),
);

it.effect("expires credentials after inactivity", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

// The token is baked into the CLI process's MCP config at spawn and cannot be
// rotated mid-session, so a short lifetime just breaks t3-code tools partway
// through a conversation. Guard the defaults against a well-meaning revert.
it("keeps credential lifetimes long enough to outlive a working session", () => {
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;
  expect(McpSessionRegistry.__testing.defaultIdleTimeoutMs).toBe(thirtyDaysMs);
  expect(McpSessionRegistry.__testing.defaultMaximumLifetimeMs).toBe(thirtyDaysMs);
});

it.effect("keeps a credential alive well past the old 8-hour ceiling", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* McpSessionRegistry.__testing.make({ now: () => timestamp }).pipe(
      Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
      Effect.provideService(ServerEnvironment, fakeEnvironment),
      Effect.provideService(ProjectionSnapshotQuery, fakeSnapshotQuery(new Map())),
      Effect.provideService(
        ServerSettingsService,
        ServerSettingsService.of({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            orchestratorProjectId: null,
          }),
        } as unknown as ServerSettingsService["Service"]),
      ),
      Effect.provide(NodeServices.layer),
    );
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-long-lived"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    // Three days later, with no MCP tool call in between.
    timestamp += 3 * 24 * 60 * 60 * 1_000;
    expect((yield* registry.resolve(token))?.threadId).toBe(ThreadId.make("thread-long-lived"));
  }),
);
