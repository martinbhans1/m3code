/**
 * ClaudeSessionRetention — stop Claude Code from deleting the sessions our
 * threads resume from.
 *
 * Claude Code garbage-collects its own transcripts: anything in
 * `<config dir>/projects` older than `cleanupPeriodDays` is removed, and the
 * default is 30 days. That default is fine for the CLI, where a transcript is
 * only ever a convenience. It is not fine here, because a transcript *is* a
 * thread's agent memory — once it is gone the thread shows its full history in
 * the UI but can never be continued by the agent that wrote it.
 *
 * Setting it by hand does not hold: this app launches several Claude accounts,
 * each with its own `CLAUDE_CONFIG_DIR`, a new one is a few clicks away, and a
 * freshly created config dir starts at the 30-day default. So the app raises the
 * floor itself, once per instance, for whichever config dir that instance will
 * actually read.
 *
 * It only ever raises. A value already at or above the floor is left untouched,
 * and so is every other key in the file — this is the user's own settings file,
 * shared with the Claude Code CLI.
 *
 * @module ClaudeSessionRetention
 */
import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { resolveClaudeConfigDirPath } from "./ClaudeHome.ts";

/**
 * Ten years. The point is "never", and `cleanupPeriodDays` has no "never" —
 * so this is the number that means it while still being a plain integer the
 * CLI accepts.
 */
export const CLAUDE_SESSION_RETENTION_FLOOR_DAYS = 3650;

export type ClaudeSessionRetentionOutcome =
  /** Already at or above the floor — nothing written. */
  | { readonly kind: "already-sufficient"; readonly configDir: string; readonly days: number }
  /** Raised to the floor, from the default or from a lower explicit value. */
  | {
      readonly kind: "raised";
      readonly configDir: string;
      readonly previousDays?: number;
      readonly days: number;
    }
  /** Could not be applied; the reason is for the log, not the user. */
  | { readonly kind: "skipped"; readonly configDir: string; readonly reason: string };

function readCleanupPeriodDays(settings: Record<string, unknown>): number | undefined {
  const value = settings.cleanupPeriodDays;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type ParsedSettings =
  | { readonly kind: "object"; readonly settings: Record<string, unknown> }
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * Parse the settings file we are about to edit, refusing anything we cannot
 * round-trip. This is the user's own file, shared with the Claude Code CLI;
 * rewriting a shape we did not understand would destroy their settings.
 */
function parseClaudeSettingsFile(contents: string): ParsedSettings {
  const trimmed = contents.trim();
  if (trimmed.length === 0) {
    return { kind: "object", settings: {} };
  }
  let parsed: unknown;
  try {
    // Claude Code's own settings file: an arbitrary object we must preserve
    // key-for-key, not a shape we model. A schema would have to describe every
    // setting the CLI has or ever adds, and anything it failed to describe would
    // be silently dropped on write.
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "unreadable", reason: "settings.json is not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unreadable", reason: "settings.json is not a JSON object" };
  }
  return { kind: "object", settings: parsed as Record<string, unknown> };
}

/**
 * Raise `cleanupPeriodDays` in one config dir's `settings.json` to the floor.
 *
 * Best-effort by construction: a missing dir, unreadable file or malformed JSON
 * returns `skipped` rather than failing. Blocking a provider instance from
 * starting because we could not edit a settings file would be a far worse
 * outcome than the retention risk it protects against.
 */
export const ensureClaudeSessionRetention = Effect.fn("ensureClaudeSessionRetention")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ClaudeSessionRetentionOutcome, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* resolveClaudeConfigDirPath(config, environment);
  const settingsPath = path.join(configDir, "settings.json");

  const existingContents = yield* fileSystem
    .readFileString(settingsPath)
    .pipe(Effect.orElseSucceed(() => ""));

  const parsed = parseClaudeSettingsFile(existingContents);
  if (parsed.kind === "unreadable") {
    return { kind: "skipped", configDir, reason: parsed.reason } as const;
  }
  const settings = parsed.settings;

  const previousDays = readCleanupPeriodDays(settings);
  if (previousDays !== undefined && previousDays >= CLAUDE_SESSION_RETENTION_FLOOR_DAYS) {
    return { kind: "already-sufficient", configDir, days: previousDays } as const;
  }

  const next = { ...settings, cleanupPeriodDays: CLAUDE_SESSION_RETENTION_FLOOR_DAYS };
  const written = yield* writeFileStringAtomically({
    filePath: settingsPath,
    // Written back for a human to read and hand-edit, so it keeps the CLI's
    // two-space layout rather than being re-encoded by a schema.
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    contents: `${JSON.stringify(next, null, 2)}\n`,
  }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!written) {
    return { kind: "skipped", configDir, reason: "settings.json could not be written" } as const;
  }

  return {
    kind: "raised",
    configDir,
    ...(previousDays !== undefined ? { previousDays } : {}),
    days: CLAUDE_SESSION_RETENTION_FLOOR_DAYS,
  } as const;
});

/**
 * Apply the floor and log what happened, swallowing anything unexpected.
 *
 * This is what driver creation calls: it must never be able to stop an instance
 * from coming up.
 */
export const applyClaudeSessionRetention = Effect.fn("applyClaudeSessionRetention")(function* (
  input: {
    readonly instanceId: string;
    readonly config: Pick<ClaudeSettings, "homePath">;
  },
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const outcome = yield* ensureClaudeSessionRetention(input.config, environment).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("claude.session-retention.failed", {
        instanceId: input.instanceId,
        cause,
      }).pipe(Effect.as(undefined)),
    ),
  );
  if (outcome === undefined) return;
  if (outcome.kind === "raised") {
    yield* Effect.logInfo("claude.session-retention.raised", {
      instanceId: input.instanceId,
      configDir: outcome.configDir,
      previousDays: outcome.previousDays ?? "default",
      days: outcome.days,
    });
    return;
  }
  if (outcome.kind === "skipped") {
    yield* Effect.logWarning("claude.session-retention.skipped", {
      instanceId: input.instanceId,
      configDir: outcome.configDir,
      reason: outcome.reason,
    });
  }
});
