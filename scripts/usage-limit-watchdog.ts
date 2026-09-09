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
import { writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findAbandoned,
  formatAbandoned,
  type AbandonedConversation,
} from "./lib/watchdog-abandoned.ts";
import { decide, type ScanDecision, type ThreadVerdict } from "./lib/watchdog-decide.ts";
import {
  formatOutages,
  recordOutage,
  summariseOutages,
  type Outage,
} from "./lib/watchdog-outages.ts";
import {
  buildRunnerScript,
  buildTaskXml,
  consolePopupHelperExists,
  parseConsolePopupAudit,
  type ConsolePopupAudit,
  CONSOLE_POPUP_HELPER,
  deleteTask,
  readTaskAction,
  registerTaskFromXml,
  runConsolePopupHelper,
  SCAN_TASK_NAME,
  taskExists,
  taskLaunchesHidden,
  toTaskBoundary,
  WAKE_TASK_NAME,
  wakeTimeFor,
  writeTaskXmlFile,
} from "./lib/watchdog-schedule.ts";
import { observe, type Snapshot } from "./lib/watchdog-observe.ts";
import { dispatchNudge, ensureAccessToken, NudgeError } from "./lib/watchdog-nudge.ts";
import {
  acquireScanLock,
  appendLedgerEntry,
  appendLogLine,
  ensureWatchdogDirs,
  newScanId,
  pruneScans,
  readConfig,
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
const SCAN_INTERVAL_MINUTES = 5;
/** Get up a couple of minutes after the limit lifts, not on the dot. */
const WAKE_GRACE_MS = 3 * 60_000;
/** The scheduled-task audit is machine-wide and slow-ish; once a day is plenty. */
const CONSOLE_AUDIT_INTERVAL_MS = 24 * 60 * 60_000;

interface WakeTaskOutcome {
  readonly armedFor: string | null;
  readonly changed: boolean;
  readonly detail: string;
}

interface DeliveryRecord {
  readonly attemptedAt: string;
  readonly threadId: string;
  readonly outcome: "sent" | "failed" | "skipped-dry-run" | "simulated";
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
  readonly wake: WakeTaskOutcome;
  /** Never acted on; recorded so the status output can surface them. */
  readonly abandoned: readonly AbandonedConversation[];
  /** Daily check that nothing on this machine has been given a window-flashing task. */
  readonly consolePopups: ConsolePopupAudit | null;
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

interface ScanOptions {
  /** Decide and record, but send nothing. */
  readonly dryRun: boolean;
  /**
   * Record the nudge in the ledger as though it had been delivered, without
   * delivering it. Only for rehearsals against a sandbox store, so it refuses
   * to run unless the caller has pointed the whole watchdog somewhere else.
   */
  readonly simulate: boolean;
}

/**
 * Once a day, ask whether anything on this machine has been given a task that
 * will flash a console window.
 *
 * The watchdog is the only thing here that runs unattended all day, so it is
 * the natural place to keep asking. Whoever creates the next bad task will not
 * be looking for it - this is.
 */
function auditConsolePopups(paths: WatchdogPaths, now: Date): ConsolePopupAudit | null {
  if (!IS_WINDOWS || !consolePopupHelperExists()) return null;
  const previous = readJsonFile<ConsolePopupAudit>(paths.consoleAuditFile);
  if (previous && now.getTime() - new Date(previous.ranAt).getTime() < CONSOLE_AUDIT_INTERVAL_MS) {
    return previous;
  }
  try {
    const audit = parseConsolePopupAudit(runConsolePopupHelper(false), now.toISOString());
    writeJsonFile(paths.consoleAuditFile, audit);
    if (audit.repeatingOffenders.length > 0) {
      appendLogLine(
        paths,
        `scheduled tasks that will flash a console window: ${audit.repeatingOffenders.join(", ")}`,
      );
    }
    return audit;
  } catch {
    // silent-ok: an audit that cannot run must not stop the watchdog working
    return previous;
  }
}

async function runScan({ dryRun, simulate }: ScanOptions): Promise<number> {
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
    const abandoned = findAbandoned(snapshot.stoppedMidWork, startedAt);
    const consolePopups = auditConsolePopups(paths, startedAt);

    // The watchdog cannot start the app, so when the app is down it can only
    // record what that cost. See watchdog-outages.ts.
    if (!snapshot.serverRunning && !dryRun && !simulate) {
      const restartable = decision.verdicts.filter(
        (verdict) => verdict.verdict === "restart",
      ).length;
      writeJsonFile(
        paths.outagesFile,
        recordOutage(readJsonFile<readonly Outage[]>(paths.outagesFile) ?? [], startedAt, restartable),
      );
      if (restartable > 0) {
        appendLogLine(
          paths,
          `app is down and ${restartable} conversation(s) are waiting on a limit that has lifted`,
        );
      }
    }
    let delivery: DeliveryRecord | null = null;

    if (decision.action.kind === "nudge") {
      const action = decision.action;
      const target = snapshot.threads.find((thread) => thread.threadId === action.threadId);
      if (simulate) {
        delivery = {
          attemptedAt: new Date().toISOString(),
          threadId: action.threadId,
          outcome: "simulated",
        };
      } else if (dryRun) {
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
        outcome: delivery.outcome === "sent" || delivery.outcome === "simulated" ? "sent" : "failed",
        ...(delivery.outcome === "simulated" ? { detail: "simulated, nothing was sent" } : {}),
        ...(delivery.detail ? { detail: delivery.detail } : {}),
      };
      if (!dryRun) appendLedgerEntry(paths, entry);
    }

    // Re-arm the wake before anything else that could fail: a scan that dies
    // writing artefacts must still have pointed the machine at the next reset.
    const wake = dryRun || simulate
      ? ({ armedFor: null, changed: false, detail: "skipped-dry-run" } satisfies WakeTaskOutcome)
      : syncWakeTask(paths, decision.waitingUntil, startedAt);

    const finishedAt = new Date();
    const record: ScanRecord = {
      scanId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      dryRun,
      snapshot,
      decision,
      delivery,
      wake,
      abandoned,
      consolePopups,
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
      wake,
      abandoned,
      consolePopups,
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
    const waiting = decision.waitingUntil ? `, waiting until ${decision.waitingUntil}` : "";
    const summary =
      decision.action.kind === "nudge"
        ? `nudged ${decision.action.threadId} (${delivery?.outcome})`
        : `no action: ${decision.action.reason}${waiting}`;
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
  const latest = readJsonFile<{
    readonly abandoned?: readonly AbandonedConversation[];
    readonly consolePopups?: ConsolePopupAudit | null;
  }>(paths.latestScanFile);
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
  // The point of this section is that nothing else in the app will ever tell
  // him: a conversation that died on a crash is invisible from every surface.
  process.stdout.write(`\n${formatAbandoned(latest?.abandoned ?? [])}`);

  const outages = readJsonFile<readonly Outage[]>(paths.outagesFile) ?? [];
  process.stdout.write(`\n${formatOutages(summariseOutages(outages, new Date()))}`);

  const offenders = latest?.consolePopups?.repeatingOffenders ?? [];
  if (offenders.length > 0) {
    process.stdout.write(
      `\nScheduled tasks that will flash a console window and steal focus:\n${offenders
        .map((task) => `  ${task}`)
        .join("\n")}\nFix them with: powershell -File ${CONSOLE_POPUP_HELPER} -Fix\n`,
    );
  }
  return 0;
}

/**
 * The command the tasks run, in a `.cmd` so every unattended run leaves its
 * output somewhere readable. Nothing points a task at this file directly - see
 * install().
 */
function writeRunnerScript(paths: WatchdogPaths): void {
  const scanCommand = `"${process.execPath}" --no-warnings "${join(REPO_ROOT, "scripts", "usage-limit-watchdog.ts")}" scan >> "${paths.runLogFile}" 2>&1`;
  writeFileSync(paths.runnerFile, buildRunnerScript(scanCommand));
}

/** `DOMAIN\user`, which is what Task Scheduler resolves to an account. */
function currentUserId(): string {
  const domain = process.env["USERDOMAIN"];
  const name = process.env["USERNAME"] ?? userInfo().username;
  return domain ? [domain, name].join("\\") : name;
}

const SCRIPT_HOST = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "wscript.exe");

interface WakeTaskState {
  readonly armedFor: string | null;
  readonly updatedAt: string;
}

/**
 * Re-arm the single-shot task that wakes the machine.
 *
 * Called at the end of every scan, so the wake always points at the earliest
 * reset the watchdog currently knows about, and disappears entirely when
 * nothing is waiting. Re-registering costs a process spawn, so it only happens
 * when the target minute actually changes.
 */
function syncWakeTask(
  paths: WatchdogPaths,
  waitingUntil: string | null,
  now: Date,
): WakeTaskOutcome {
  try {
    return armWakeTask(paths, waitingUntil, now);
  } catch (error) {
    // Losing the wake costs a late restart; letting it throw would cost the
    // whole scan, including the record of what the watchdog just saw.
    return {
      armedFor: null,
      changed: false,
      detail: `could-not-arm-the-wake: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function armWakeTask(
  paths: WatchdogPaths,
  waitingUntil: string | null,
  now: Date,
): WakeTaskOutcome {
  if (!IS_WINDOWS) return { armedFor: null, changed: false, detail: "not-windows" };
  if (!readConfig(paths).wakeMachine) {
    return { armedFor: null, changed: false, detail: "waking-the-machine-is-switched-off" };
  }
  const wakeAt = wakeTimeFor(waitingUntil, now, WAKE_GRACE_MS);
  const previous = readJsonFile<WakeTaskState>(paths.wakeStateFile);
  const desired = wakeAt ? toTaskBoundary(wakeAt) : null;

  // "Unchanged" has to mean the scheduler agrees, not just that our own note
  // does: a wake armed by something else, or left behind when these artefacts
  // were cleared, would otherwise keep waking the machine for a reset that has
  // long since passed.
  const registered = taskExists(WAKE_TASK_NAME);
  if (desired === (previous?.armedFor ?? null) && registered === (desired !== null)) {
    return { armedFor: desired, changed: false, detail: "unchanged" };
  }
  if (desired === null) {
    deleteTask(WAKE_TASK_NAME);
    writeJsonFile(paths.wakeStateFile, {
      armedFor: null,
      updatedAt: now.toISOString(),
    } satisfies WakeTaskState);
    return { armedFor: null, changed: true, detail: "nothing-is-waiting-so-the-wake-was-cleared" };
  }
  // Reuses the wrapper the house helper wrote for the heartbeat: same command,
  // and the helper only wraps repeating tasks, so a single-shot task of our own
  // making would otherwise be the one thing on the machine still flashing.
  const wrapper = readJsonFile<{ readonly wrapper: string }>(paths.wrapperStateFile)?.wrapper;
  if (!wrapper) {
    return {
      armedFor: null,
      changed: false,
      detail: "no-hidden-wrapper-recorded-run-install-again",
    };
  }
  const xmlFile = join(paths.root, "wake-task.xml");
  writeTaskXmlFile(
    xmlFile,
    buildTaskXml({
      description:
        "Wakes this machine once, when a usage limit that stopped work is due to lift.",
      userId: currentUserId(),
      scriptHost: SCRIPT_HOST,
      scriptPath: wrapper,
      startBoundary: desired,
      wakeToRun: true,
    }),
  );
  registerTaskFromXml(WAKE_TASK_NAME, xmlFile);
  writeJsonFile(paths.wakeStateFile, {
    armedFor: desired,
    updatedAt: now.toISOString(),
  } satisfies WakeTaskState);
  return { armedFor: desired, changed: true, detail: "armed" };
}

/**
 * Register the heartbeat, then hand it to the house helper to be wrapped.
 *
 * The task is deliberately registered pointing at the `.cmd` - the shape that
 * flashes - and immediately handed to `Check-ConsolePopupTasks.ps1 -Fix`, which
 * writes the wrapper and repoints it. Going through the helper rather than
 * writing a wrapper here means there is exactly one wrapper pattern on the
 * machine and the audit can see this task the same way it sees every other.
 *
 * If the helper is missing, the task is removed again rather than left in the
 * flashing shape: a watchdog that steals focus twelve times an hour is worse
 * than no watchdog.
 */
function wrapScanTaskHidden(): string {
  if (!consolePopupHelperExists()) {
    deleteTask(SCAN_TASK_NAME);
    throw new Error(
      `The scheduled task would open a console window on every run, and the wrapper helper is missing at ${CONSOLE_POPUP_HELPER}. Nothing was left registered.`,
    );
  }
  runConsolePopupHelper(true);
  const action = readTaskAction(SCAN_TASK_NAME);
  if (!taskLaunchesHidden(action)) {
    deleteTask(SCAN_TASK_NAME);
    throw new Error(
      `The wrapper helper did not repoint the task at the script host (it still runs ${action?.execute ?? "nothing"}). Nothing was left registered.`,
    );
  }
  // The single-shot wake task runs the same command, so it reuses the wrapper
  // the helper just wrote. The helper itself only wraps repeating tasks.
  return (action as { readonly arguments: string }).arguments.replaceAll('"', "");
}

function install(noWake: boolean): number {
  const paths = watchdogPaths();
  ensureWatchdogDirs(paths);
  writeRunnerScript(paths);
  writeJsonFile(paths.configFile, { wakeMachine: !noWake });
  if (!IS_WINDOWS) {
    process.stdout.write(
      `Not Windows. Add this to cron:\n*/${SCAN_INTERVAL_MINUTES} * * * * "${process.execPath}" "${join(REPO_ROOT, "scripts", "usage-limit-watchdog.ts")}" scan >> "${paths.runLogFile}" 2>&1\n`,
    );
    return 0;
  }
  const xmlFile = join(paths.root, "scan-task.xml");
  const startBoundary = toTaskBoundary(new Date(Date.now() + 60_000));
  writeTaskXmlFile(
    xmlFile,
    buildTaskXml({
      description: "Restarts conversations that a usage limit stopped, once the limit lifts.",
      userId: currentUserId(),
      scriptHost: paths.runnerFile,
      scriptPath: "",
      startBoundary,
      repeatEveryMinutes: SCAN_INTERVAL_MINUTES,
      // The heartbeat never wakes the machine; the single-shot task does.
      wakeToRun: false,
    }),
  );
  registerTaskFromXml(SCAN_TASK_NAME, xmlFile);
  const wrapper = wrapScanTaskHidden();
  writeJsonFile(paths.wrapperStateFile, { wrapper, wrappedAt: new Date().toISOString() });
  if (noWake) {
    deleteTask(WAKE_TASK_NAME);
    writeJsonFile(paths.wakeStateFile, { armedFor: null, updatedAt: new Date().toISOString() });
  }
  process.stdout.write(
    [
      `Registered ${SCAN_TASK_NAME}: every ${SCAN_INTERVAL_MINUTES} minutes, runs on battery, no window.`,
      noWake
        ? "Waking the machine is switched off, so a reset that lands while it sleeps waits until you wake it."
        : `Each scan re-arms ${WAKE_TASK_NAME} for the next known reset, which may wake the machine.`,
      "Undo everything with: pnpm watchdog:uninstall",
      "Keep the watchdog but stop it waking the machine: pnpm watchdog:install -- --no-wake",
      "",
    ].join("\n"),
  );
  return 0;
}

function uninstall(): number {
  const paths = watchdogPaths();
  if (!IS_WINDOWS) {
    process.stdout.write("Not Windows: remove the cron line you added.\n");
    return 0;
  }
  const removedScan = deleteTask(SCAN_TASK_NAME);
  const removedWake = deleteTask(WAKE_TASK_NAME);
  writeJsonFile(paths.wakeStateFile, { armedFor: null, updatedAt: new Date().toISOString() });
  process.stdout.write(
    `Removed ${removedScan ? SCAN_TASK_NAME : "nothing"}${removedWake ? ` and ${WAKE_TASK_NAME}` : ""}. Artefacts under ${paths.root} are left alone.\n`,
  );
  return 0;
}

const [command = "scan", ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "scan": {
      const simulate = rest.includes("--simulate");
      if (simulate && !process.env["T3CODE_HOME"]) {
        process.stderr.write(
          "Refusing to simulate against the real store: set T3CODE_HOME to a sandbox first.\n",
        );
        process.exitCode = 2;
        break;
      }
      process.exitCode = await runScan({ dryRun: rest.includes("--dry-run"), simulate });
      break;
    }
    case "status":
      process.exitCode = printStatus();
      break;
    case "install":
      process.exitCode = install(rest.includes("--no-wake"));
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
