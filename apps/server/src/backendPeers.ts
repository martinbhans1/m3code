/**
 * backendPeers - whether this backend is sharing its data directory.
 *
 * Boot records whether another backend was already serving this state
 * directory (the dev server started from the repo defaults to the installed
 * app's home). Nothing here changes what that other process does; it changes
 * what *we* are willing to do to records we did not write.
 *
 * The distinction matters because ownership is stamped going forward but not
 * backwards: a session row written by a build that predates the stamp names no
 * owner, and "no owner" is not "mine". Alone, claiming those rows is right -
 * they are almost certainly this app's own from before the last restart.
 * Sharing the directory, claiming them means reaching into a conversation
 * running in the other process, which is the whole failure this exists to
 * stop. See `sessionOwner`.
 *
 * @module backendPeers
 */
import { isProcessAlive } from "./serverRuntimeState.ts";

let siblingBackendPid: number | null = null;

/** Called at boot when the runtime state file names a backend that is still up. */
export function markLiveSiblingBackend(pid: number): void {
  siblingBackendPid = pid;
}

/**
 * Re-checked on every call rather than cached: the sibling can exit at any
 * point, and once it has, its sessions are ours to clean up like any other.
 */
export function hasLiveSiblingBackend(): boolean {
  return siblingBackendPid !== null && isProcessAlive(siblingBackendPid);
}

/** Test seam; production only ever sets this through the boot check. */
export function resetLiveSiblingBackend(): void {
  siblingBackendPid = null;
}
