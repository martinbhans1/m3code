/**
 * Idle compaction — shared rules for compacting an idle Claude thread before
 * its prompt cache expires.
 *
 * Claude caches the conversation prefix for an hour on subscriptions (five
 * minutes on API keys). Coming back after that re-sends the whole transcript at
 * full price; a `/compact` sent while the cache is still warm reads it cheaply
 * and leaves a short summary for the return.
 *
 * @module idleCompaction
 */
import {
  ClaudeSettings,
  defaultInstanceIdForDriver,
  type IdleCompactionMode,
  type OrchestrationTurnInitiator,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Context size below which compaction is not worth it: a cold re-read of a
 * smaller thread is cheap, so compacting would mostly throw context away.
 * Matches Claude Code's own idle-compaction default.
 */
export const IDLE_COMPACTION_MIN_CONTEXT_TOKENS = 200_000;

/**
 * How long before the cache expires the compaction starts: enough for a
 * stopped session to resume and send the request while the cache is warm.
 */
export const IDLE_COMPACTION_LEAD_MS = 2 * 60_000;

/**
 * Only Claude's one-hour cache is worth racing. Five minutes would fire while
 * the user is still reading the reply.
 */
export const IDLE_COMPACTION_REQUIRED_CACHE_TTL_MS = 60 * 60_000;

/**
 * Prefix of the command id, and of the user message id, of the `/compact` turn
 * the server sends on an idle thread. The message id is how every reader —
 * the projection, the sidebar, the timeline — tells that turn from one the
 * user typed, with nothing extra persisted.
 */
export const IDLE_COMPACTION_ID_PREFIX = "idle-compact:";

/** Whether a user message is the `/compact` the server sent on an idle thread. */
export const isIdleCompactionMessageId = (messageId: string | null | undefined): boolean =>
  messageId?.startsWith(IDLE_COMPACTION_ID_PREFIX) ?? false;

/** Who started a turn the user did not: set on the turn, absent for the user's own. */
export const turnInitiatedByForMessageId = (
  messageId: string | null | undefined,
): OrchestrationTurnInitiator | undefined =>
  isIdleCompactionMessageId(messageId) ? "idleCompaction" : undefined;

/**
 * Who started the turn the latest user message opened, for a client building a
 * new turn from live events before the server's shell says so.
 */
export function turnInitiatedByLatestUserMessage(
  messages: ReadonlyArray<{ readonly id: string; readonly role: string }>,
): OrchestrationTurnInitiator | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return turnInitiatedByForMessageId(message.id);
  }
  return undefined;
}

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

/**
 * The Claude config an instance runs with: its explicit `providerInstances`
 * entry, else the legacy `providers.claudeAgent` blob for the default slot —
 * the same precedence the provider registry uses.
 */
function claudeInstanceConfig(
  settings: Pick<ServerSettings, "providerInstances" | "providers">,
  instanceId: ProviderInstanceId,
): unknown {
  if (Object.hasOwn(settings.providerInstances, instanceId)) {
    const entry = settings.providerInstances[instanceId];
    return entry?.driver === CLAUDE_DRIVER ? entry.config : undefined;
  }
  return instanceId === defaultInstanceIdForDriver(CLAUDE_DRIVER)
    ? settings.providers.claudeAgent
    : undefined;
}

/** The idle compaction mode for one provider instance: its override, else the global default. */
export function resolveIdleCompaction(
  settings: Pick<ServerSettings, "compactIdleThreads" | "providerInstances" | "providers">,
  instanceId: ProviderInstanceId,
): IdleCompactionMode {
  const override = decodeClaudeSettings(claudeInstanceConfig(settings, instanceId) ?? {}).pipe(
    Option.map((config) => config.idleCompaction),
    Option.getOrElse(() => "default" as const),
  );
  return override === "default" ? settings.compactIdleThreads : override;
}
