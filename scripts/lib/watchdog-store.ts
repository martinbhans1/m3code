// @effect-diagnostics globalDate:off - Standalone watchdog process, no Effect runtime.
// @effect-diagnostics globalRandom:off - Scan ids only need to be unique on disk.
/**
 * watchdog-store - Where the usage-limit watchdog keeps its paper trail.
 *
 * The watchdog runs unattended, at night, and its whole job is to spend money
 * on Martin's behalf. That is only acceptable if every run can be audited after
 * the fact, so each stage writes a file: a scan record of what it saw and
 * decided, a per-conversation receipt of what it poked and when, and a ledger
 * of every nudge ever sent (which is also what enforces the spend caps).
 *
 * Deliberately plain node: this process has to keep working when the app it
 * watches is wedged, so it shares no runtime with it.
 */
// @effect-diagnostics nodeBuiltinImport:off - must run standalone of the app runtime
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Mirrors the app's own base-dir rule so the watchdog reads the store the app writes. */
export function resolveBaseDir(raw: string | undefined = process.env["T3CODE_HOME"]): string {
  const trimmed = raw?.trim();
  if (!trimmed) return join(homedir(), ".t3");
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

export interface WatchdogPaths {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly databaseFile: string;
  readonly serverRuntimeFile: string;
  readonly settingsFile: string;
  readonly root: string;
  readonly scansDir: string;
  readonly receiptsDir: string;
  readonly ledgerFile: string;
  readonly latestScanFile: string;
  readonly lockFile: string;
  readonly logFile: string;
  readonly tokenFile: string;
  readonly configFile: string;
  readonly wakeStateFile: string;
  readonly wrapperStateFile: string;
  readonly consoleAuditFile: string;
  readonly outagesFile: string;
  readonly runnerFile: string;
  readonly runLogFile: string;
}

export function watchdogPaths(baseDir = resolveBaseDir()): WatchdogPaths {
  const stateDir = join(baseDir, "userdata");
  const root = join(baseDir, "watchdog");
  return {
    baseDir,
    stateDir,
    databaseFile: join(stateDir, "state.sqlite"),
    serverRuntimeFile: join(stateDir, "server-runtime.json"),
    settingsFile: join(stateDir, "settings.json"),
    root,
    scansDir: join(root, "scans"),
    receiptsDir: join(root, "receipts"),
    ledgerFile: join(root, "ledger.json"),
    latestScanFile: join(root, "latest-scan.json"),
    lockFile: join(root, "watchdog.lock"),
    logFile: join(root, "watchdog.log"),
    tokenFile: join(root, "access-token.json"),
    configFile: join(root, "config.json"),
    wakeStateFile: join(root, "wake-task.json"),
    wrapperStateFile: join(root, "hidden-wrapper.json"),
    consoleAuditFile: join(root, "console-popup-audit.json"),
    outagesFile: join(root, "app-outages.json"),
    runnerFile: join(root, "run-scan.cmd"),
    runLogFile: join(root, "scan-runs.log"),
  };
}

export function ensureWatchdogDirs(paths: WatchdogPaths): void {
  for (const dir of [paths.root, paths.scansDir, paths.receiptsDir]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** Write-then-rename, so a reader never catches a half-written artefact. */
export function writeJsonFile(file: string, value: unknown): void {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

export function appendLogLine(paths: WatchdogPaths, line: string): void {
  appendFileSync(paths.logFile, `${new Date().toISOString()} ${line}\n`);
}

export function isPidAlive(pid: number | null | undefined): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * One scan at a time.
 *
 * The scheduler is supposed to prevent overlap, but a hand-run `scan` while the
 * scheduled one is mid-flight would otherwise let both read the same stalled
 * conversation and both nudge it - the exact double-spend the caps exist to
 * stop.
 */
export function acquireScanLock(paths: WatchdogPaths): boolean {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = openSync(paths.lockFile, "wx");
      writeSync(handle, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
      closeSync(handle);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      const holder = readJsonFile<{ pid: number }>(paths.lockFile);
      // A run killed mid-scan leaves the file behind; only a dead owner releases it.
      if (holder && holder.pid !== process.pid && isPidAlive(holder.pid)) return false;
      removeIfExists(paths.lockFile);
    }
  }
  return false;
}

export function releaseScanLock(paths: WatchdogPaths): void {
  const holder = readJsonFile<{ pid: number }>(paths.lockFile);
  if (holder && holder.pid !== process.pid) return;
  removeIfExists(paths.lockFile);
}

export function removeIfExists(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // silent-ok: the file being gone is the outcome we wanted
  }
}

/** One entry per nudge actually sent. This is the spend record, so it is append-only. */
export interface LedgerEntry {
  readonly at: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly projectTitle: string | null;
  readonly providerInstanceId: string | null;
  readonly resetWindow: string;
  readonly attempt: number;
  readonly scanId: string;
  readonly outcome: "sent" | "failed";
  readonly detail?: string;
}

export interface Ledger {
  readonly entries: readonly LedgerEntry[];
}

export function readLedger(paths: WatchdogPaths): Ledger {
  return readJsonFile<Ledger>(paths.ledgerFile) ?? { entries: [] };
}

export function appendLedgerEntry(paths: WatchdogPaths, entry: LedgerEntry): Ledger {
  const previous = readLedger(paths);
  // Keeps the file bounded without losing the window the caps actually consult.
  const kept = previous.entries.slice(-500);
  const next: Ledger = { entries: [...kept, entry] };
  writeJsonFile(paths.ledgerFile, next);
  return next;
}

export function scanRecordPath(paths: WatchdogPaths, scanId: string): string {
  return join(paths.scansDir, `${scanId}.json`);
}

export function receiptPath(paths: WatchdogPaths, threadId: string): string {
  return join(paths.receiptsDir, `${threadId}.json`);
}

/** Keep the last `keep` scan records so the directory stays readable by hand. */
export function pruneScans(paths: WatchdogPaths, keep = 400): void {
  try {
    const files = readdirSync(paths.scansDir)
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of files.slice(0, Math.max(0, files.length - keep))) {
      removeIfExists(join(paths.scansDir, name));
    }
  } catch {
    // silent-ok: pruning is housekeeping, never a reason to fail a scan
  }
}

export interface WatchdogConfig {
  /** May the watchdog arm a task that wakes the machine for a known reset? */
  readonly wakeMachine: boolean;
}

export const DEFAULT_CONFIG: WatchdogConfig = { wakeMachine: true };

export function readConfig(paths: WatchdogPaths): WatchdogConfig {
  return { ...DEFAULT_CONFIG, ...readJsonFile<Partial<WatchdogConfig>>(paths.configFile) };
}

export function newScanId(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function fileExists(file: string): boolean {
  return existsSync(file);
}
