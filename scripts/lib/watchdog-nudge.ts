// @effect-diagnostics globalDate:off - Standalone watchdog process, no Effect runtime.
// @effect-diagnostics anyUnknownInErrorContext:off - The app's RPC group is consumed dynamically by tag.
// @effect-diagnostics unsafeEffectTypeAssertion:off - Same: one dynamic call, errors handled by the caller.
/**
 * watchdog-nudge - Deliver the wake-up through the app's own front door.
 *
 * The watchdog does not write to the event store or poke the database: it opens
 * the same authenticated socket a phone would and dispatches the same
 * `thread.turn.start` the composer dispatches. Anything it starts is therefore
 * an ordinary turn, visible and interruptible in the UI, with no privileged
 * path to maintain.
 *
 * Its bearer token is minted headlessly from the CLI that ships with the app
 * and cached until shortly before it expires, so a 03:40 restart never depends
 * on a human being awake to authorise anything.
 */
// @effect-diagnostics nodeBuiltinImport:off - must run standalone of the app runtime
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { ORCHESTRATION_WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { readJsonFile, writeJsonFile, type WatchdogPaths } from "./watchdog-store.ts";

/** Long enough that a quiet night never re-mints; short enough to be worth revoking. */
const TOKEN_TTL = "12h";
const TOKEN_RENEW_MARGIN_MS = 30 * 60_000;
const DISPATCH_TIMEOUT_MS = 30_000;

interface CachedToken {
  readonly token: string;
  readonly expiresAt: string;
}

export interface NudgeTarget {
  readonly threadId: string;
  readonly text: string;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly modelSelection: unknown;
}

export class NudgeError extends Error {}

function serverCliPath(repoRoot: string): string {
  return join(repoRoot, "apps", "server", "dist", "bin.mjs");
}

/**
 * Read the token's own expiry rather than trusting the TTL we asked for; the
 * token is a signed base64 payload, so this is a read, not a verification.
 */
function tokenExpiry(token: string): Date | null {
  const payload = token.split(".")[0];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as {
      exp?: number;
    };
    return typeof decoded.exp === "number" ? new Date(decoded.exp) : null;
  } catch {
    return null;
  }
}

export function ensureAccessToken(
  paths: WatchdogPaths,
  repoRoot: string,
  now = new Date(),
): string {
  const cached = readJsonFile<CachedToken>(paths.tokenFile);
  if (cached && new Date(cached.expiresAt).getTime() - now.getTime() > TOKEN_RENEW_MARGIN_MS) {
    return cached.token;
  }
  const cli = serverCliPath(repoRoot);
  if (!existsSync(cli)) {
    throw new NudgeError(
      `Cannot mint an access token: ${cli} is missing. Build the server once (pnpm build) so the watchdog has a CLI to mint with.`,
    );
  }
  const stdout = execFileSync(
    process.execPath,
    [
      cli,
      "auth",
      "session",
      "issue",
      "--token-only",
      "--ttl",
      TOKEN_TTL,
      "--label",
      "usage-limit-watchdog",
      "--base-dir",
      paths.baseDir,
    ],
    { encoding: "utf-8", windowsHide: true, timeout: 120_000 },
  );
  const token = stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
  if (token.length === 0) throw new NudgeError("The auth CLI returned no token.");
  const expiresAt = tokenExpiry(token) ?? new Date(now.getTime() + 6 * 60 * 60_000);
  writeJsonFile(paths.tokenFile, {
    token,
    expiresAt: expiresAt.toISOString(),
  } satisfies CachedToken);
  return token;
}

function protocolLayer(socketUrl: string, token: string) {
  // The bearer goes in the upgrade headers rather than the query string: the
  // socket URL ends up in logs and scan records, and a token in a query string
  // is a token in a file someone can read.
  const webSocketConstructor = Layer.succeed(
    Socket.WebSocketConstructor,
    (url, protocols) =>
      new NodeSocket.NodeWS.WebSocket(url, protocols, {
        headers: { authorization: `Bearer ${token}` },
      }) as unknown as globalThis.WebSocket,
  );
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(socketUrl).pipe(Layer.provide(webSocketConstructor))),
    Layer.provide(RpcSerialization.layerJson),
  );
}

export function websocketUrl(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  return url.toString();
}

/**
 * Send the wake-up as a normal user turn.
 *
 * Returns the command receipt so the scan record can carry proof the app
 * accepted it, rather than just proof that we tried.
 */
export async function dispatchNudge(
  origin: string,
  token: string,
  target: NudgeTarget,
): Promise<unknown> {
  const payload = {
    type: "thread.turn.start" as const,
    commandId: randomUUID(),
    threadId: target.threadId,
    message: {
      messageId: randomUUID(),
      role: "user" as const,
      text: target.text,
      attachments: [],
    },
    ...(target.modelSelection ? { modelSelection: target.modelSelection } : {}),
    runtimeMode: target.runtimeMode,
    interactionMode: target.interactionMode,
    createdAt: new Date().toISOString(),
  };

  const program = RpcClient.make(WsRpcGroup).pipe(
    Effect.flatMap((client) =>
      (client as unknown as Record<string, (input: unknown) => Effect.Effect<unknown, unknown>>)[
        ORCHESTRATION_WS_METHODS.dispatchCommand
      ]!(payload),
    ),
    Effect.timeout(DISPATCH_TIMEOUT_MS),
    Effect.scoped,
    Effect.provide(protocolLayer(websocketUrl(origin), token)),
  );

  return await Effect.runPromise(program as Effect.Effect<unknown, never, never>);
}
