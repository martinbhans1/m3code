import * as NodeOS from "node:os";

import * as FileSystem from "effect/FileSystem";
import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    HOME: resolvedHomePath,
  };
});

/**
 * Where Claude keeps this instance's credentials, settings and transcripts.
 *
 * `CLAUDE_CONFIG_DIR` — set per instance in its environment list — wins over
 * the HOME override, which is how a machine runs several accounts off one
 * binary. With neither, Claude falls back to `<home>/.claude`.
 */
export const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const configDir = (environment ?? process.env).CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (configDir.length > 0) return path.resolve(expandHomePath(configDir));
  return path.join(yield* resolveClaudeHomePath(config), ".claude");
});

/**
 * The transcript store a Claude instance resumes from: `<config dir>/projects`,
 * with symlinks resolved.
 *
 * Resolving matters — two config dirs commonly share one transcript store by
 * symlinking `projects/`, and those instances genuinely can resume each other's
 * threads. Instances whose stores differ cannot, and must not be offered as
 * continuations of one another.
 */
export const resolveClaudeSessionStorePath = Effect.fn("resolveClaudeSessionStorePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const sessionStore = path.join(
    yield* resolveClaudeConfigDirPath(config, environment),
    "projects",
  );
  return yield* fileSystem.realPath(sessionStore).pipe(Effect.orElseSucceed(() => sessionStore));
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
    return `claude:sessions:${yield* resolveClaudeSessionStorePath(config, environment)}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    // Auth and model access follow the config dir, not the transcript store —
    // two accounts sharing transcripts must still probe separately.
    const resolvedConfigDir = yield* resolveClaudeConfigDirPath(config, environment);
    return `${config.binaryPath}\0${resolvedHomePath}\0${resolvedConfigDir}`;
  },
);
