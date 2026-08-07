import type { RepositoryIdentity } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@t3tools/shared/git";

import * as ProcessRunner from "../../processRunner.ts";
import {
  RepositoryIdentityResolver,
  type RepositoryIdentityResolverShape,
} from "../Services/RepositoryIdentityResolver.ts";

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  for (const preferredRemoteName of ["upstream", "origin"] as const) {
    const remoteUrl = remotes.get(preferredRemoteName);
    if (remoteUrl) {
      return { remoteName: preferredRemoteName, remoteUrl };
    }
  }

  const [remoteName, remoteUrl] =
    [...remotes.entries()].toSorted(([left], [right]) => left.localeCompare(right))[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly rootPath: string;
}): RepositoryIdentity {
  const canonicalKey = normalizeGitRemoteUrl(input.remoteUrl);
  const sourceControlProvider = detectSourceControlProviderFromGitRemoteUrl(input.remoteUrl);
  const repositoryPath = canonicalKey.split("/").slice(1).join("/");
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    rootPath: input.rootPath,
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
  };
}

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(1);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);

interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}

/**
 * The git top-level for `cwd`, or null when it is not inside a work tree.
 *
 * This is the expensive half of resolution: a process spawn, which on Windows
 * under load has been measured in the hundreds of milliseconds. `getSnapshot`
 * calls the resolver once per project and runs on every snapshot broadcast, so
 * this must not happen per call — see the root cache below.
 */
const resolveRepositoryRoot = Effect.fn("resolveRepositoryRoot")(function* (cwd: string) {
  const processRunner = yield* ProcessRunner.ProcessRunner;

  // git is a real executable on every platform — no cmd.exe shell mode, which
  // would split paths containing spaces during cmd's re-tokenization.
  const topLevelResult = yield* processRunner
    .run({
      command: "git",
      args: ["-C", cwd, "rev-parse", "--show-toplevel"],
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  if (topLevelResult._tag === "None" || topLevelResult.value.code !== 0) {
    return null;
  }

  const candidate = topLevelResult.value.stdout.trim();
  return candidate.length > 0 ? candidate : null;
});

const resolveRepositoryIdentityFromCacheKey = Effect.fn("resolveRepositoryIdentityFromCacheKey")(
  function* (
    cacheKey: string,
  ): Effect.fn.Return<RepositoryIdentity | null, never, ProcessRunner.ProcessRunner> {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const remoteResult = yield* processRunner
      .run({
        command: "git",
        args: ["-C", cacheKey, "remote", "-v"],
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (remoteResult._tag === "None" || remoteResult.value.code !== 0) {
      return null;
    }

    const remote = pickPrimaryRemote(parseRemoteFetchUrls(remoteResult.value.stdout));
    return remote ? buildRepositoryIdentity({ ...remote, rootPath: cacheKey }) : null;
  },
);

export const makeRepositoryIdentityResolver = Effect.fn("makeRepositoryIdentityResolver")(
  function* (options: RepositoryIdentityResolverOptions = {}) {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const fileSystem = yield* FileSystem.FileSystem;

    /**
     * cwd -> git top-level, so the identity cache's key can be computed without
     * spawning git every time. Without this the identity cache below was close
     * to pointless: its key came from a subprocess that ran on every call, so a
     * "cached" resolve still cost a process spawn.
     *
     * Shares the identity cache's TTLs on purpose. A directory that is not a
     * repository yet caches as null and starts resolving once someone runs
     * `git init` and the negative TTL lapses; a checkout that moves stops being
     * served after the positive TTL, and sooner than that via the liveness
     * check in `readRepositoryRoot`.
     */
    const repositoryRootCache = yield* Cache.makeWith<string, string | null>(
      (cwd) =>
        resolveRepositoryRoot(cwd).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        ),
      {
        capacity: options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY,
        timeToLive: Exit.match({
          onSuccess: (value) =>
            value === null
              ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
              : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
          onFailure: () => Duration.zero,
        }),
      },
    );

    const repositoryIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
      (cacheKey) =>
        resolveRepositoryIdentityFromCacheKey(cacheKey).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        ),
      {
        capacity: options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY,
        timeToLive: Exit.match({
          onSuccess: (value) =>
            value === null
              ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
              : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
          onFailure: () => Duration.zero,
        }),
      },
    );

    /**
     * The cached top-level for `cwd`, dropping an entry that no longer points
     * at a directory.
     *
     * A checkout that is moved or deleted would otherwise keep resolving to its
     * old path until the TTL lapsed, and every identity lookup against a path
     * that is gone comes back null — the repository would silently lose its
     * identity in the UI for up to a minute. `exists` is a stat, three orders of
     * magnitude cheaper than the spawn it guards, so paying it on every resolve
     * to bound staleness at one call is a good trade. Being unable to answer is
     * treated as "still there": failing open costs a stale minute, failing
     * closed costs a process spawn per resolve, which is the bug being fixed.
     */
    const readRepositoryRoot = Effect.fn("RepositoryIdentityResolver.readRepositoryRoot")(
      function* (cwd: string) {
        const cachedRoot = yield* Cache.get(repositoryRootCache, cwd);
        if (cachedRoot === null) {
          return null;
        }

        const rootStillExists = yield* fileSystem
          .exists(cachedRoot)
          .pipe(Effect.orElseSucceed(() => true));
        if (rootStillExists) {
          return cachedRoot;
        }

        yield* Cache.invalidate(repositoryRootCache, cwd);
        return yield* Cache.get(repositoryRootCache, cwd);
      },
    );

    const resolve: RepositoryIdentityResolverShape["resolve"] = Effect.fn(
      "RepositoryIdentityResolver.resolve",
    )(function* (cwd) {
      const repositoryRoot = yield* readRepositoryRoot(cwd);
      return yield* Cache.get(repositoryIdentityCache, repositoryRoot ?? cwd);
    });

    return {
      resolve,
    } satisfies RepositoryIdentityResolverShape;
  },
);

export const RepositoryIdentityResolverLive = Layer.effect(
  RepositoryIdentityResolver,
  makeRepositoryIdentityResolver(),
).pipe(Layer.provide(ProcessRunner.layer));
