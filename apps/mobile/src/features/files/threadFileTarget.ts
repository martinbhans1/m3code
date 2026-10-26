import { isWindowsAbsolutePath, resolveOwningWorkspaceRoot } from "@t3tools/shared/path";

export interface ThreadFileReadTarget {
  /** Directory the server reads relative to. */
  readonly cwd: string;
  readonly relativePath: string;
  /** 1-based line the link pointed at, when it named one. */
  readonly line: number | null;
}

const POSITION_SUFFIX_PATTERN = /:(\d+)(?::\d+)?$/;

function splitPosition(target: string): { readonly path: string; readonly line: number | null } {
  const match = target.match(POSITION_SUFFIX_PATTERN);
  if (!match) {
    return { path: target, line: null };
  }
  const line = Number.parseInt(match[1] ?? "", 10);
  return {
    path: target.slice(0, match.index),
    line: Number.isFinite(line) && line > 0 ? line : null,
  };
}

/**
 * Turn a file link from a chat message into something the server can read.
 *
 * Relative links are read from the conversation's own folder. Absolute links
 * are read from whichever known project contains them, so a conversation that
 * discusses another repo still opens that repo's file. A file that sits in no
 * known project (a plan in a temp folder, a note in the home directory) is read
 * from its own folder, because those are exactly the files an agent points at
 * when it says "the full plan is here".
 */
export function resolveThreadFileReadTarget(input: {
  readonly target: string;
  readonly threadCwd: string | null;
  readonly knownRoots: Iterable<string | null | undefined>;
}): ThreadFileReadTarget | null {
  const { path, line } = splitPosition(input.target.trim());
  if (path.length === 0) {
    return null;
  }

  const isAbsolute = path.startsWith("/") || isWindowsAbsolutePath(path);
  if (!isAbsolute) {
    // "~" means the server user's home directory, which the phone cannot know.
    if (path.startsWith("~") || !input.threadCwd) {
      return null;
    }
    return {
      cwd: input.threadCwd,
      relativePath: path.replace(/^\.[\\/]/, ""),
      line,
    };
  }

  const owning = resolveOwningWorkspaceRoot(path, [input.threadCwd, ...input.knownRoots]);
  if (owning) {
    return { cwd: owning.workspaceRoot, relativePath: owning.relativePath, line };
  }

  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const basename = path.slice(separatorIndex + 1);
  if (basename.length === 0) {
    return null;
  }
  // Keep the separator when the parent is a filesystem root ("/" or "C:\").
  const directory = path.slice(
    0,
    separatorIndex === 0 || path[separatorIndex - 1] === ":" ? separatorIndex + 1 : separatorIndex,
  );
  return { cwd: directory, relativePath: basename, line };
}

export function fileBasename(path: string): string {
  const { path: withoutPosition } = splitPosition(path);
  const separatorIndex = Math.max(
    withoutPosition.lastIndexOf("/"),
    withoutPosition.lastIndexOf("\\"),
  );
  return withoutPosition.slice(separatorIndex + 1) || withoutPosition;
}

export function isMarkdownFilePath(path: string): boolean {
  return /\.(?:md|mdx|markdown)$/i.test(splitPosition(path).path);
}
