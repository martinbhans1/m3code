// @effect-diagnostics nodeBuiltinImport:off
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isProcessAlive } from "./serverRuntimeState.ts";

/**
 * backendPeers - whether this backend is sharing its data directory.
 *
 * One state directory can be served by several backends at once: the dev
 * server started from the repo defaults to the installed app's home, and the
 * CLI opens the same database again. Knowing that changes what we are willing
 * to do to records we did not write.
 *
 * It matters because ownership is stamped going forward but not backwards: a
 * session row written by a build that predates the stamp names no owner, and
 * "no owner" is not "mine". Alone, claiming those rows is right — they are
 * this app's own from before the last restart. Sharing the directory, claiming
 * them means reaching into a conversation running in the other process, which
 * is the whole failure this exists to stop. See `sessionOwner`.
 *
 * Each backend drops a file named after its process id here and removes it on
 * the way out, so the question "is anybody else serving this directory" is
 * answered by reading a directory and asking the OS which of those processes
 * still exist. `server-runtime.json` cannot answer it: there is only one of
 * those and the newest backend overwrites it, so a backend that restarts often
 * erases every trace of its longer-lived neighbour.
 *
 * @module backendPeers
 */

/** Files left by a backend that was killed rather than stopped are swept on sight. */
interface PeerRecord {
  readonly pid: number;
  readonly startedAt: string;
}

const PEER_SCAN_CACHE_NS = 5_000_000_000n;

let peersDir: string | null = null;
let siblingBackendPid: number | null = null;
/** Monotonic, so a clock change cannot pin a stale answer in place. */
let lastScan: { readonly atNs: bigint; readonly sharing: boolean } | null = null;

const peerFileName = (pid: number) => `${pid}.json`;

const pidFromFileName = (fileName: string): number | null => {
  const match = /^(\d+)\.json$/.exec(fileName);
  if (match === null) {
    return null;
  }
  const pid = Number.parseInt(match[1] as string, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

/**
 * Announce this backend and take note of who else is here.
 *
 * Safe to call more than once; the second call simply rewrites our own file.
 */
export function registerBackendPeer(directory: string, startedAt: string): void {
  peersDir = directory;
  lastScan = null;
  try {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
    const record: PeerRecord = { pid: process.pid, startedAt };
    writeFileSync(join(directory, peerFileName(process.pid)), `${JSON.stringify(record)}\n`);
  } catch {
    // A directory we cannot write to costs us the sharing signal, not the boot.
  }
}

export function unregisterBackendPeer(): void {
  if (peersDir === null) {
    return;
  }
  try {
    rmSync(join(peersDir, peerFileName(process.pid)), { force: true });
  } catch {
    // Left behind at worst; the next scan sweeps it once the pid is gone.
  }
  peersDir = null;
  lastScan = null;
}

/** Called at boot when the runtime state file still names a backend that is up. */
export function markLiveSiblingBackend(pid: number): void {
  siblingBackendPid = pid;
  lastScan = null;
}

const scanPeers = (directory: string): boolean => {
  let sharing = false;
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(directory);
  } catch {
    return false;
  }
  for (const entry of entries) {
    const pid = pidFromFileName(entry);
    if (pid === null || pid === process.pid) {
      continue;
    }
    if (isProcessAlive(pid)) {
      sharing = true;
      continue;
    }
    // The backend that wrote this was killed without running its finalizer,
    // which on Windows is every stop. Clear it so the directory keeps
    // describing reality.
    try {
      rmSync(join(directory, entry), { force: true });
    } catch {
      // Another backend may be sweeping the same file; either way it goes.
    }
  }
  return sharing;
};

/**
 * Whether another backend is serving this data directory right now.
 *
 * Called from synchronous decision code, so the directory scan is cached for a
 * few seconds: a neighbour that appears or exits is noticed on the next sweep,
 * which is far finer-grained than the jobs asking the question.
 */
export function hasLiveSiblingBackend(): boolean {
  if (siblingBackendPid !== null && isProcessAlive(siblingBackendPid)) {
    return true;
  }
  if (peersDir === null) {
    return false;
  }
  const nowNs = process.hrtime.bigint();
  if (lastScan !== null && nowNs - lastScan.atNs < PEER_SCAN_CACHE_NS) {
    return lastScan.sharing;
  }
  const sharing = scanPeers(peersDir);
  lastScan = { atNs: nowNs, sharing };
  return sharing;
}

/** Test seam; production only ever sets this through registration. */
export function resetBackendPeers(): void {
  peersDir = null;
  siblingBackendPid = null;
  lastScan = null;
}
