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

/** What Claude names the file it keeps an account's OAuth tokens in. */
export const CLAUDE_CREDENTIALS_FILE_NAME = ".credentials.json";

/**
 * This instance's config dir with symlinks resolved, so two spellings of one
 * directory compare equal. Falls back to the unresolved path when the dir does
 * not exist yet — Claude creates it on first run.
 */
export const resolveClaudeConfigDirRealPath = Effect.fn("resolveClaudeConfigDirRealPath")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const configDirPath = yield* resolveClaudeConfigDirPath(config, environment);
    return yield* fileSystem
      .realPath(configDirPath)
      .pipe(Effect.orElseSucceed(() => configDirPath));
  },
);

/**
 * The file holding this instance's OAuth tokens, with symlinks resolved.
 *
 * Resolving is the entire point. Claude mints a fresh refresh token on every
 * refresh and kills the previous one, and it takes the lock that serialises
 * that refresh inside the *config dir* — so two config dirs whose credentials
 * file is one file (a symlink, a junction, the same dir named twice) hold two
 * copies of one rotating token behind two locks that know nothing about each
 * other. Whichever refreshes second is told `invalid_grant`, and Claude's
 * answer to a dead refresh token is to blank the tokens where it found them.
 * That signs both accounts out of a file neither thought it was sharing.
 *
 * Falls back to the resolved config dir's own path when the file is absent:
 * Claude writes it on first sign-in, and an instance that has never signed in
 * is not sharing anything yet.
 */
export const resolveClaudeCredentialsPath = Effect.fn("resolveClaudeCredentialsPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const credentialsPath = path.join(
    yield* resolveClaudeConfigDirRealPath(config, environment),
    CLAUDE_CREDENTIALS_FILE_NAME,
  );
  return yield* fileSystem
    .realPath(credentialsPath)
    .pipe(Effect.orElseSucceed(() => credentialsPath));
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

/**
 * How Claude Code names the per-workspace folder inside its session store:
 * every character that is not a letter or a digit becomes a dash, so
 * `C:\Users\Martin\Documents\GitHub\dealjourney\website` becomes
 * `C--Users-Martin-Documents-GitHub-dealjourney-website`.
 */
export function encodeClaudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * The transcript file a resume reads: `<store>/<encoded cwd>/<session id>.jsonl`.
 *
 * This file is the entire basis of a resume, and it is not ours — Claude Code
 * deletes it once it is older than `cleanupPeriodDays`. Being able to name it is
 * what lets us check whether a saved resume cursor is still worth anything
 * *before* spending a turn finding out the hard way.
 */
export const resolveClaudeSessionTranscriptPath = Effect.fn("resolveClaudeSessionTranscriptPath")(
  function* (
    input: {
      readonly config: Pick<ClaudeSettings, "homePath">;
      readonly cwd: string;
      readonly sessionId: string;
    },
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
    const path = yield* Path.Path;
    const store = yield* resolveClaudeSessionStorePath(input.config, environment);
    return path.join(store, encodeClaudeProjectDirName(input.cwd), `${input.sessionId}.jsonl`);
  },
);

/**
 * Whether a Claude session can still be resumed from this instance's store.
 *
 * Absence is the answer we act on: a missing transcript means the resume will
 * fail, every time, so the thread is better served by a fresh session seeded
 * with the history we hold. Any *other* problem (an unreadable store, a path we
 * cannot resolve) answers "yes" — guessing "no" there would throw away a live
 * session's memory over a transient filesystem error.
 */
export const claudeSessionTranscriptExists = Effect.fn("claudeSessionTranscriptExists")(function* (
  input: {
    readonly config: Pick<ClaudeSettings, "homePath">;
    readonly cwd: string;
    readonly sessionId: string;
  },
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const transcriptPath = yield* resolveClaudeSessionTranscriptPath(input, environment);
  return yield* fileSystem.exists(transcriptPath).pipe(Effect.orElseSucceed(() => true));
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
