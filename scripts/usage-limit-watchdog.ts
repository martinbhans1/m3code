#!/usr/bin/env node
// @effect-diagnostics globalDate:off - Standalone watchdog process, no Effect runtime.
/**
 * usage-limit-watchdog - Restart work that a usage limit stopped, from outside
 * the usage budget.
 *
 * The failure this exists for: an orchestrator conversation supervising five
 * workers is itself a conversation, so when the account hits its limit the
 * supervisor dies of the same cause as everything it supervises. Its scheduled
 * checks only fire while its own session is alive, so nothing restarts when the
 * limit lifts and the night is lost.
 *
 * A watchdog therefore cannot live inside a session. This one is an ordinary
 * local process the OS scheduler starts every few minutes: it reads the app's
 * state store to see what stopped, decides in `watchdog-decide.ts` whether the
 * cause was a usage limit that has since lifted, and if so opens an
 * authenticated socket to the running app and sends one conversation an
 * ordinary user turn. Every stage writes a file under `~/.t3/watchdog`.
 *
 * Commands:
 *   scan [--dry-run]  one cycle; what the scheduler runs
 *   status            what it saw and did most recently
 *   install           register the scheduled task (Windows), or print the cron line
 *   uninstall         remove the scheduled task
 */
// @effect-diagnostics nodeBuiltinImport:off - must run standalone of the app runtime
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { decide, type ScanDecision, type ThreadVerdict } from "./lib/watchdog-decide.ts";
import { observe, type Snapshot } from "./lib/watchdog-observe.ts";
import { dispatchNudge, ensureAccessToken, NudgeError } from "./lib/watchdog-nudge.ts";
import {
  acquireScanLock,
  appendLedgerEntry,
  appendLogLine,
  ensureWatchdogDirs,
  newScanId,
  pruneScans,
  readJsonFile,
  readLedger,
  receiptPath,
  releaseScanLock,
  scanRecordPath,
  watchdogPaths,
  writeJsonFile,
  type LedgerEntry,
  type WatchdogPaths,
} from "./lib/watchdog-store.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone watchdog process has no Effect runtime.
const IS_WINDOWS = process.platform === "win32";
const TASK_NAME = "M3CodeUsageLimitWatchdog";
const SCAN_INTERVAL_MINUTES = 5;

interface DeliveryRecord {
  readonly attemptedAt: string;
  readonly threadId: string;
  readonly outcome: "sent" | "failed" | "skipped-dry-run";
  readonly detail?: string;
}

interface ScanRecord {
  readonly scanId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly dryRun: boolean;
  readonly snapshot: Snapshot;
  readonly decision: ScanDecision;
  readonly delivery: DeliveryRecord | null;
}

/** One line per conversation the watchdog formed an opinion about. */
interface ThreadReceipt {
  readonly threadId: string;
  readonly title: string;
  readonly projectTitle: string | null;
  readonly isOrchestrator: boolean;
  readonly firstSeenStalledAt: string;
  readonly lastSeenAt: string;
  readonly lastScanId: string;
  readonly lastVerdict: ThreadVerdict;
  readonly nudges: readonly {
    readonly at: string;
    readonly outcome: string;
    readonly resetWindow: string;
    readonly detail?: string;
  }[];
}

function upsertReceipt(
  paths: WatchdogPaths,
  scanId: string,
  now: Date,
  verdict: ThreadVerdict,
  nudge?: { readonly outcome: string; readonly resetWindow: string; readonly detail?: string },
): void {
  const file = receiptPath(paths, verdict.threadId);
  const previous = readJsonFile<ThreadReceipt>(file);
  const receipt: ThreadReceipt = {
    threadId: verdict.threadId,
    title: verdict.title,
    projectTitle: verdict.projectTitle,
    isOrchestrator: verdict.isOrchestrator,
    firstSeenStalledAt: previous?.firstSeenStalledAt ?? (verdict.failedAt ?? now.toISOString()),
    lastSeenAt: now.toISOString(),
    lastScanId: scanId,
    lastVerdict: verdict,
    nudges: nudge
      ? [...(previous?.nudges ?? []), { at: now.toISOString(), ...nudge }]
      : (previous?.nudges ?? []),
  };
  writeJsonFile(file, receipt);
}

async function runScan(dryRun: boolean): Promise<number> {
  const paths = watchdogPaths();
  ensureWatchdogDirs(paths);
  const startedAt = new Date();
  const scanId = newScanId(startedAt);

  if (!acquireScanLock(paths)) {
    appendLogLine(paths, `${scanId} skipped: another scan holds the lock`);
    return 0;
  }

  try {
    const snapshot = observe(paths, startedAt);
    const ledger = readLedger(paths).entries;
    const decision = decide(snapshot, ledger, startedAt);
    let delivery: DeliveryRecord | null = null;

    if (decision.action.kind === "nudge") {
      const action = decision.action;
      const target = snapshot.threads.find((thread) => thread.threadId === action.threadId);
      if (dryRun) {
        delivery = {
          attemptedAt: new Date().toISOString(),
          threadId: action.threadId,
          outcome: "skipped-dry-run",
        };
      } else if (!target || !snapshot.serverOrigin) {
        delivery = {
          attemptedAt: new Date().toISOString(),
          threadId: action.threadId,
          outcome: "failed",
          detail: "the conversation or the running server disappeared between reading and acting",
        };
      } else {
        try {
          const token = ensureAccessToken(paths, REPO_ROOT, startedAt);
          await dispatchNudge(snapshot.serverOrigin, token, {
            threadId: action.threadId,
            text: action.message,
            runtimeMode: target.runtimeMode,
            interactionMode: target.interactionMode,
            modelSelection: target.modelSelection,
          });
          delivery = {
            attemptedAt: new Date().toISOString(),
            threadId: action.threadId,
            outcome: "sent",
          };
        } catch (error) {
          delivery = {
            attemptedAt: new Date().toISOString(),
            threadId: action.threadId,
            outcome: "failed",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }

      // A failed delivery is recorded but never counted as spend, so a wedged
      // socket cannot silently consume the night's whole restart budget.
      const entry: LedgerEntry = {
        at: new Date().toISOString(),
        threadId: action.threadId,
        threadTitle: action.title,
        projectTitle: action.projectTitle,
        providerInstanceId: action.providerInstanceId,
        resetWindow: action.resetWindow,
        attempt: action.attempt,
        scanId,
        outcome: delivery.outcome === "sent" ? "sent" : "failed",
        ...(delivery.detail ? { detail: delivery.detail } : {}),
      };
      if (!dryRun) appendLedgerEntry(paths, entry);
    }

    const finishedAt = new Date();
    const record: ScanRecord = {
      scanId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      dryRun,
      snapshot,
      decision,
      delivery,
    };
    writeJsonFile(scanRecordPath(paths, scanId), record);
    writeJsonFile(paths.latestScanFile, {
      scanId,
      finishedAt: finishedAt.toISOString(),
      serverRunning: snapshot.serverRunning,
      stalledConversations: snapshot.threadsWithFailedLatestTurn,
      action: decision.action,
      delivery,
      waitingUntil: decision.waitingUntil,
    });

    const action = decision.action;
    for (const verdict of decision.verdicts) {
      if (verdict.verdict === "ignore") continue;
      const nudged =
        delivery !== null && action.kind === "nudge" && delivery.threadId === verdict.threadId
          ? {
              outcome: delivery.outcome,
              resetWindow: action.resetWindow,
              ...(delivery.detail ? { detail: delivery.detail } : {}),
            }
          : undefined;
      upsertReceipt(paths, scanId, finishedAt, verdict, nudged);
    }

    pruneScans(paths);
    const summary =
      decision.action.kind === "nudge"
        ? `nudged ${decision.action.threadId} (${delivery?.outcome})`
        : `no action: ${decision.action.reason}`;
    appendLogLine(
      paths,
      `${scanId} saw ${snapshot.threadsWithFailedLatestTurn} stopped conversation(s); ${summary}${dryRun ? " [dry-run]" : ""}`,
    );
    process.stdout.write(`${scanId} ${summary}\n`);
    return 0;
  } finally {
    releaseScanLock(paths);
  }
}

function printStatus(): number {
  const paths = watchdogPaths();
  const latest = readJsonFile<Record<string, unknown>>(paths.latestScanFile);
  const ledger = readLedger(paths).entries.slice(-10);
  process.stdout.write(`watchdog artefacts: ${paths.root}\n`);
  process.stdout.write(
    latest ? `latest scan: ${JSON.stringify(latest, null, 2)}\n` : "latest scan: none yet\n",
  );
  process.stdout.write(
    ledger.length > 0
      ? `recent nudges:\n${ledger.map((entry) => `  ${entry.at} ${entry.outcome} ${entry.threadTitle} (${entry.threadId})`).join("\n")}\n`
      : "recent nudges: none\n",
  );
  return 0;
}

/**
 * The scheduled task runs a small wrapper rather than node directly: it keeps
 * the quoting sane and gives every unattended run a place to leave its stdout.
 */
function writeRunnerScript(paths: WatchdogPaths): string {
  const runner = join(paths.root, "run-scan.cmd");
  const script = [
    "@echo off",
    `"${process.execPath}" --no-warnings "${join(REPO_ROOT, "scripts", "usage-limit-watchdog.ts")}" scan >> "${join(paths.root, "scan-runs.log")}" 2>&1`,
    "",
  ].join("\r\n");
  writeFileSync(runner, script);
  return runner;
}

function install(): number {
  const paths = watchdogPaths();
  ensureWatchdogDirs(paths);
  const runner = writeRunnerScript(paths);
  if (!IS_WINDOWS) {
    process.stdout.write(
      `Not Windows. Add this to cron:\n*/${SCAN_INTERVAL_MINUTES} * * * * "${process.execPath}" "${join(REPO_ROOT, "scripts", "usage-limit-watchdog.ts")}" scan >> "${join(paths.root, "scan-runs.log")}" 2>&1\n`,
    );
    return 0;
  }
  execFileSync(
    "schtasks",
    [
      "/Create",
      "/TN",
      TASK_NAME,
      "/TR",
      runner,
      "/SC",
      "MINUTE",
      "/MO",
      String(SCAN_INTERVAL_MINUTES),
      "/F",
    ],
    { stdio: "inherit", windowsHide: true },
  );
  process.stdout.write(
    `Registered scheduled task ${TASK_NAME}, every ${SCAN_INTERVAL_MINUTES} minutes.\nRemove it with: node scripts/usage-limit-watchdog.ts uninstall\n`,
  );
  return 0;
}

function uninstall(): number {
  if (!IS_WINDOWS) {
    process.stdout.write("Not Windows: remove the cron line you added.\n");
    return 0;
  }
  execFileSync("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"], {
    stdio: "inherit",
    windowsHide: true,
  });
  return 0;
}

const [command = "scan", ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "scan":
      process.exitCode = await runScan(rest.includes("--dry-run"));
      break;
    case "status":
      process.exitCode = printStatus();
      break;
    case "install":
      process.exitCode = install();
      break;
    case "uninstall":
      process.exitCode = uninstall();
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\nUse scan | status | install | uninstall\n`);
      process.exitCode = 2;
  }
} catch (error) {
  const message = error instanceof NudgeError ? error.message : String(error);
  process.stderr.write(`usage-limit-watchdog failed: ${message}\n`);
  process.exitCode = 1;
}
