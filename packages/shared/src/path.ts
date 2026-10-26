export function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:([/\\]|$)/.test(value);
}

export function isUncPath(value: string): boolean {
  return value.startsWith("\\\\");
}

export function isWindowsAbsolutePath(value: string): boolean {
  return isUncPath(value) || isWindowsDrivePath(value);
}

export function isExplicitRelativePath(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\")
  );
}

function normalizeComparablePath(value: string): string {
  const slashed = value.replaceAll("\\", "/");
  return /^\/[A-Za-z]:\//.test(slashed) ? slashed.slice(1) : slashed;
}

/**
 * Where `path` sits inside `workspaceRoot`, or null when it is outside it.
 * Separators and drive-letter case are ignored, so a Windows path written with
 * forward slashes still matches its root.
 */
export function workspaceRelativePath(
  path: string,
  workspaceRoot: string | null | undefined,
): string | null {
  if (!workspaceRoot) return null;
  const normalizedPath = normalizeComparablePath(path);
  const normalizedRoot = normalizeComparablePath(workspaceRoot).replace(/\/+$/, "");
  if (!normalizedPath.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) return null;
  return normalizedPath.slice(normalizedRoot.length + 1);
}

/**
 * Which of the known workspace roots actually contains this absolute path, and
 * where inside it.
 *
 * A conversation can name a file belonging to a different project than its own
 * - the orchestrator does it constantly, since its own "workspace" is an empty
 * state directory. A file preview needs a root that really contains the file,
 * not the root of whichever thread happens to be open, or the read fails with a
 * bare "could not read workspace file".
 *
 * Longest match wins, so a worktree nested inside a project beats the project.
 */
export function resolveOwningWorkspaceRoot(
  absolutePath: string,
  candidateRoots: Iterable<string | null | undefined>,
): { workspaceRoot: string; relativePath: string } | null {
  let best: { workspaceRoot: string; relativePath: string } | null = null;
  for (const root of candidateRoots) {
    if (!root) continue;
    const relativePath = workspaceRelativePath(absolutePath, root);
    if (relativePath === null) continue;
    if (best === null || root.length > best.workspaceRoot.length) {
      best = { workspaceRoot: root, relativePath };
    }
  }
  return best;
}
