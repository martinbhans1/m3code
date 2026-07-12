// @effect-diagnostics nodeBuiltinImport:off
import type { Dirent } from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectEntry,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";

import * as WorkspacePaths from "./Services/WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

export class WorkspaceEntriesError extends Schema.TaggedErrorClass<WorkspaceEntriesError>()(
  "WorkspaceEntriesError",
  {
    cwd: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class WorkspaceEntriesBrowseError extends Schema.TaggedErrorClass<WorkspaceEntriesBrowseError>()(
  "WorkspaceEntriesBrowseError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;
    readonly list: (
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceEntries") {}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), input.slice(2));
  }
  return input;
}

const resolveBrowseTarget = (
  input: FilesystemBrowseInput,
  path: Path.Path,
): Effect.Effect<string, WorkspaceEntriesBrowseError> =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    if (platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
      return yield* new WorkspaceEntriesBrowseError({
        cwd: input.cwd,
        partialPath: input.partialPath,
        operation: "workspaceEntries.resolveBrowseTarget",
        detail: "Windows-style paths are only supported on Windows.",
      });
    }

    if (!isExplicitRelativePath(input.partialPath)) {
      return path.resolve(expandHomePath(input.partialPath, path));
    }

    if (!input.cwd) {
      return yield* new WorkspaceEntriesBrowseError({
        cwd: input.cwd,
        partialPath: input.partialPath,
        operation: "workspaceEntries.resolveBrowseTarget",
        detail: "Relative filesystem browse paths require a current project.",
      });
    }

    return path.resolve(expandHomePath(input.cwd, path), input.partialPath);
  });

// The workspace search index honors `.gitignore`, so `.env` files (which are
// almost always ignored) never make it into the file tree. We supplement the
// indexed entries with a targeted walk that surfaces `.env`-style files so they
// can be browsed and edited in-app, while keeping the universally-huge ignored
// directories out of the tree.
const ENV_SCAN_MAX_FILES = 100;
const ENV_SCAN_MAX_DIRECTORIES = 10_000;
const ENV_SCAN_PRUNED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".terraform",
  ".gradle",
  ".cache",
]);

function isEnvFileName(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

function parentPosixPath(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  return separatorIndex === -1 ? undefined : input.slice(0, separatorIndex);
}

// Best-effort walk: never throws, swallows per-directory errors, and is bounded
// by file/directory caps so a pathological tree can't hang a list() call.
async function collectEnvRelativePaths(root: string): Promise<string[]> {
  const found: string[] = [];
  const stack: Array<{ readonly absolute: string; readonly relative: string }> = [
    { absolute: root, relative: "" },
  ];
  let visitedDirectories = 0;

  while (
    stack.length > 0 &&
    found.length < ENV_SCAN_MAX_FILES &&
    visitedDirectories < ENV_SCAN_MAX_DIRECTORIES
  ) {
    const current = stack.pop();
    if (!current) break;
    visitedDirectories += 1;

    let dirents: Array<Dirent>;
    try {
      dirents = await NodeFSP.readdir(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of dirents) {
      // `withFileTypes` does not follow symlinks, so symlinked directories report
      // `isDirectory() === false` and are naturally skipped — avoiding cycles.
      if (dirent.isDirectory()) {
        if (ENV_SCAN_PRUNED_DIRECTORIES.has(dirent.name)) continue;
        stack.push({
          absolute: NodePath.join(current.absolute, dirent.name),
          relative: current.relative ? `${current.relative}/${dirent.name}` : dirent.name,
        });
      } else if (dirent.isFile() && isEnvFileName(dirent.name)) {
        found.push(current.relative ? `${current.relative}/${dirent.name}` : dirent.name);
        if (found.length >= ENV_SCAN_MAX_FILES) break;
      }
    }
  }

  return found;
}

function mergeFloatedEnvEntries(
  base: ProjectListEntriesResult,
  envPaths: ReadonlyArray<string>,
): ProjectListEntriesResult {
  if (envPaths.length === 0) return base;

  const entriesByPath = new Map<string, ProjectEntry>(
    base.entries.map((entry) => [entry.path, entry]),
  );
  for (const envPath of envPaths) {
    if (entriesByPath.has(envPath)) continue;
    entriesByPath.set(envPath, { path: envPath, kind: "file" });
    let parentPath = parentPosixPath(envPath);
    while (parentPath && !entriesByPath.has(parentPath)) {
      entriesByPath.set(parentPath, { path: parentPath, kind: "directory" });
      parentPath = parentPosixPath(parentPath);
    }
  }

  const entries = [...entriesByPath.values()].toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
  return { entries, truncated: base.truncated };
}

const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceSearchIndexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceEntriesError({
            cwd,
            operation: "workspaceEntries.normalizeWorkspaceRoot",
            detail: cause.message,
            cause,
          }),
      ),
    );
  });

  const refresh: WorkspaceEntries["Service"]["refresh"] = Effect.fn("WorkspaceEntries.refresh")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
      );
      if (!(yield* RcMap.has(workspaceSearchIndexes.rcMap, normalizedCwd))) {
        return;
      }
      yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        yield* searchIndex.refresh();
      }).pipe(
        Effect.provide(workspaceSearchIndexes.get(normalizedCwd)),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Failed to refresh workspace search index", {
              cwd,
              cause,
            });
            yield* workspaceSearchIndexes.invalidate(normalizedCwd);
          }),
        ),
      );
    },
  );

  const browse: WorkspaceEntries["Service"]["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      const resolvedInputPath = yield* resolveBrowseTarget(input, path);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

      const dirents = yield* Effect.tryPromise({
        try: () => NodeFSP.readdir(parentPath, { withFileTypes: true }),
        catch: (cause) =>
          new WorkspaceEntriesBrowseError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            operation: "workspaceEntries.browse.readDirectory",
            detail: `Unable to browse '${parentPath}': ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) => {
            const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
            return code === "EACCES" || code === "EPERM";
          },
          () => Effect.succeed([]),
        ),
      );

      const showHidden = endsWithSeparator || prefix.startsWith(".");
      const lowerPrefix = prefix.toLowerCase();
      const entries: Array<{ readonly name: string; readonly fullPath: string }> = [];
      for (const dirent of dirents) {
        if (
          dirent.isDirectory() &&
          dirent.name.toLowerCase().startsWith(lowerPrefix) &&
          (showHidden || !dirent.name.startsWith("."))
        ) {
          entries.push({
            name: dirent.name,
            fullPath: path.join(parentPath, dirent.name),
          });
        }
      }

      return {
        parentPath,
        entries: entries.toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
  );

  const search: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      const normalizedQuery = input.query
        .trim()
        .toLowerCase()
        .replace(/^[@./]+/, "");
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.search(normalizedQuery, input.limit);
      }).pipe(
        Effect.provide(workspaceSearchIndexes.get(normalizedCwd)),
        Effect.mapError(
          (cause) =>
            new WorkspaceEntriesError({
              cwd: input.cwd,
              operation: "workspaceEntries.search",
              detail: cause.message,
              cause,
            }),
        ),
      );
    },
  );

  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      const baseResult = yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.list();
      }).pipe(
        Effect.provide(workspaceSearchIndexes.get(normalizedCwd)),
        Effect.mapError(
          (cause) =>
            new WorkspaceEntriesError({
              cwd: input.cwd,
              operation: "workspaceEntries.list",
              detail: cause.message,
              cause,
            }),
        ),
      );

      // Surface `.env`-style files the gitignore-aware index leaves out.
      const envPaths = yield* Effect.promise(() => collectEnvRelativePaths(normalizedCwd));
      return mergeFloatedEnvEntries(baseResult, envPaths);
    },
  );

  return WorkspaceEntries.of({ browse, list, refresh, search });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
);
