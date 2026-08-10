import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/unstable/http";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
  readonly expiresAt: number;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly lastUsedAt: number;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly idleTimeoutMs?: number;
  readonly maximumLifetimeMs?: number;
  readonly now?: () => number;
}

/** Route the shared toolkits (preview, follow-ups) are served from. */
export const MCP_PATH = "/mcp";
/**
 * Route the cross-thread orchestrator toolkit is served from. Kept as a
 * sibling rather than a `/mcp/...` child so it cannot be reached by prefix
 * matching on the shared route, and so its tools are absent from the shared
 * server's `tools/list` — MCP can only filter that list by client identity,
 * which is the same for every thread.
 */
export const MCP_ORCHESTRATOR_PATH = "/mcp-orchestrator";

/**
 * Credential lifetimes.
 *
 * These were 30 minutes idle / 8 hours absolute, which produced a steady drip
 * of "token expired" failures mid-conversation. The token is minted once when a
 * provider session starts and baked into the CLI process's MCP server config at
 * spawn (`mcpServers["t3-code"].headers.Authorization`), so it can never be
 * rotated while that session lives: the moment it lapses, every t3-code tool
 * call fails until the whole provider session restarts. And the idle clock ran
 * on MCP *tool calls*, not on user activity — a half hour of ordinary coding
 * without touching a t3-code tool was enough to kill it.
 *
 * Expiry was buying very little here. The credential is thread-scoped, bound to
 * a 127.0.0.1 endpoint, held only in memory (so every server restart mints
 * fresh ones), and explicitly revoked when the thread's session stops or is
 * replaced. A month is effectively "as long as this server process lives".
 */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAXIMUM_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const serverSettings = yield* ServerSettingsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maximumLifetimeMs = options.maximumLifetimeMs ?? DEFAULT_MAXIMUM_LIFETIME_MS;
  const origin =
    httpServer.address._tag === "TcpAddress"
      ? `http://127.0.0.1:${httpServer.address.port}`
      : "http://127.0.0.1";
  const endpoint = `${origin}${MCP_PATH}`;
  const orchestratorEndpoint = `${origin}${MCP_ORCHESTRATOR_PATH}`;

  // A thread only gets cross-thread powers when it lives in the project the
  // user designated as the orchestrator project. Both lookups fall back to
  // "not the orchestrator project" on failure: a settings read error or a
  // missing thread row must never widen a credential's scope.
  const resolveCapabilities = Effect.fn("McpSessionRegistry.resolveCapabilities")(function* (
    threadId: ThreadId,
  ) {
    const capabilities = new Set<McpInvocationContext.McpCapability>(["preview"]);
    const orchestratorProjectId = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.orchestratorProjectId),
      Effect.orElseSucceed(() => null),
    );
    if (orchestratorProjectId === null) return capabilities;

    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(thread) && thread.value.projectId === orchestratorProjectId) {
      capabilities.add("orchestrator");
    }
    return capabilities;
  });

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const pruneExpired = (records: ReadonlyMap<string, CredentialRecord>, timestamp: number) => {
    const next = new Map(
      Array.from(records).filter(
        ([, record]) =>
          timestamp <= record.scope.expiresAt && timestamp - record.lastUsedAt <= idleTimeoutMs,
      ),
    );
    return next.size === records.size ? records : next;
  };

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      const providerSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const expiresAt = issuedAt + maximumLifetimeMs;
      const capabilities = yield* resolveCapabilities(request.threadId);
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        threadId: ThreadId.make(request.threadId),
        providerSessionId,
        providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
        capabilities,
        issuedAt,
        expiresAt,
      };
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(pruneExpired(records, issuedAt));
        next.set(tokenHash, { tokenHash, scope, lastUsedAt: issuedAt });
        return { records: next };
      });
      return {
        config: {
          environmentId,
          threadId: scope.threadId,
          providerSessionId,
          providerInstanceId: scope.providerInstanceId,
          endpoint,
          orchestratorEndpoint: capabilities.has("orchestrator") ? orchestratorEndpoint : null,
          authorizationHeader: `Bearer ${rawToken}`,
        },
        expiresAt,
      };
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const timestamp = yield* currentTimeMillis;
      return yield* SynchronizedRef.modify(state, ({ records }) => {
        const current = pruneExpired(records, timestamp);
        const record = current.get(tokenHash);
        if (!record) return [undefined, { records: current }] as const;
        const next = new Map(current);
        next.set(tokenHash, { ...record, lastUsedAt: timestamp });
        return [record.scope, { records: next }] as const;
      });
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.update(state, ({ records }) => ({
      records: new Map(Array.from(records).filter(([, record]) => !predicate(record))),
    }));

  return McpSessionRegistry.of({
    issue,
    resolve,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.scope.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.threadId === threadId);
    }),
    revokeAll: SynchronizedRef.set(state, { records: new Map() }),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer: Layer.Layer<
  McpSessionRegistry,
  never,
  | Crypto.Crypto
  | ServerEnvironment
  | HttpServer.HttpServer
  | ServerSettingsService
  | ProjectionSnapshotQuery
> = Layer.effect(McpSessionRegistry, make);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry
        .revokeThread(request.threadId)
        .pipe(Effect.andThen(activeMcpSessionRegistry.issue(request)))
    : Effect.sync((): McpIssuedCredential | undefined => undefined);

export const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeThread(threadId) : Effect.void;

export const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

/** Exposed for tests. */
export const __testing = {
  make: makeWithOptions,
  defaultIdleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  defaultMaximumLifetimeMs: DEFAULT_MAXIMUM_LIFETIME_MS,
};
