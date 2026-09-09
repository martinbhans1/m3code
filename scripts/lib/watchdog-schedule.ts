// @effect-diagnostics globalDate:off - Standalone watchdog process, no Effect runtime.
/**
 * watchdog-schedule - The Windows side: what runs the watchdog, and what wakes
 * the machine up for it.
 *
 * Two tasks, deliberately:
 *
 *  - a repeating one that fires every few minutes and does NOT wake anything.
 *    It is the ordinary heartbeat, and it only runs while the machine is up.
 *  - a single-shot one, re-armed by every scan, set for the exact moment the
 *    earliest known limit lifts, and allowed to wake the machine for it.
 *
 * Putting "wake the machine" on the repeating task instead would have woken it
 * every few minutes all night, which is not a watchdog, it is insomnia. This
 * way the machine sleeps until there is something specific to get up for, and
 * sleeps through nights where nothing is stalled.
 *
 * Both tasks run through `wscript.exe` and a hidden-window script rather than
 * pointing at node directly: a scheduled task aimed at a console program pops a
 * real window on every run under an interactive logon, and there is no setting
 * that suppresses it.
 */
// @effect-diagnostics nodeBuiltinImport:off - must run standalone of the app runtime
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SCAN_TASK_NAME = "M3CodeUsageLimitWatchdog";
export const WAKE_TASK_NAME = "M3CodeUsageLimitWatchdogWake";

/** Task Scheduler wants local wall-clock time with no zone suffix. */
export function toTaskBoundary(when: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    when.getFullYear(),
    "-",
    pad(when.getMonth() + 1),
    "-",
    pad(when.getDate()),
    "T",
    pad(when.getHours()),
    ":",
    pad(when.getMinutes()),
    ":",
    pad(when.getSeconds()),
  ].join("");
}

export interface TaskDefinition {
  readonly description: string;
  readonly userId: string;
  /** The program the scheduler launches. */
  readonly scriptHost: string;
  /** Its argument, if any. Empty when the program is itself the whole action. */
  readonly scriptPath: string;
  readonly startBoundary: string;
  /** Present for the heartbeat task, absent for the single-shot wake task. */
  readonly repeatEveryMinutes?: number;
  /** Only the single-shot task is allowed to wake the machine. */
  readonly wakeToRun: boolean;
}

/**
 * Both tasks run on battery and are allowed to start late if the machine was
 * off at the appointed minute; a watchdog that skips itself because the laptop
 * was unplugged is not a watchdog.
 */
export function buildTaskXml(task: TaskDefinition): string {
  const repetition =
    task.repeatEveryMinutes === undefined
      ? ""
      : `
      <Repetition>
        <Interval>PT${task.repeatEveryMinutes}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${task.description}</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>${repetition}
      <StartBoundary>${task.startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${task.userId}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>${task.wakeToRun ? "true" : "false"}</WakeToRun>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${task.scriptHost}</Command>${
        task.scriptPath === "" ? "" : `
      <Arguments>"${task.scriptPath}"</Arguments>`
      }
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * The house wrapper that keeps a scheduled task from opening a console.
 *
 * There is no way to hide a console after the fact: by the time anything could
 * hide it, the window has already been created and has already taken focus.
 * The only cure is for it never to be created, which means the task must launch
 * the script host, and the script host launches the real command with window
 * style 0.
 *
 * This delegates to Martin's own `Check-ConsolePopupTasks.ps1 -Fix` rather than
 * writing a wrapper of its own. A second, subtly different wrapper is exactly
 * how this defect came back: the audit only recognises the house shape, so a
 * private variant is invisible to the thing meant to police it.
 */
/**
 * The batch file the wrapper runs.
 *
 * Batch files are line-oriented and Windows wants CRLF: a version of this that
 * wrote the escape sequences literally produced a single line, which cmd
 * happily echoed instead of running, so every scheduled scan quietly did
 * nothing while still reporting success.
 */
export function buildRunnerScript(command: string): string {
  return ["@echo off", command, ""].join("\r\n");
}

export const CONSOLE_POPUP_HELPER = join(
  homedir(),
  ".claude",
  "scripts",
  "Check-ConsolePopupTasks.ps1",
);

export function consolePopupHelperExists(): boolean {
  return existsSync(CONSOLE_POPUP_HELPER);
}

/** Run the house audit. `fix` rewraps every repeating task that would flash. */
export function runConsolePopupHelper(fix: boolean): string {
  return execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      CONSOLE_POPUP_HELPER,
      ...(fix ? ["-Fix"] : []),
    ],
    { encoding: "utf-8", windowsHide: true, timeout: 120_000 },
  );
}

export interface ConsolePopupAudit {
  readonly ranAt: string;
  readonly clean: boolean;
  /** Tasks that repeat AND would open a window - the ones that steal focus all day. */
  readonly repeatingOffenders: readonly string[];
  readonly output: string;
}

/**
 * Read the audit's own table back.
 *
 * The check has to be able to fail on its own, without a human reading a table:
 * this class has been fixed by hand three times, and each time it came back
 * because nothing was watching for the next one.
 */
export function parseConsolePopupAudit(output: string, ranAt: string): ConsolePopupAudit {
  const lines = output.split(/\r?\n/u);
  const repeatingOffenders: string[] = [];
  for (const line of lines) {
    // The audit prints "TaskName   PT5M   ..." for anything that repeats.
    const match = /^(?<task>\S+)\s+(?<repeat>PT\d+[MH])\s/u.exec(line.trim());
    if (match?.groups?.["task"]) repeatingOffenders.push(match.groups["task"]);
  }
  return {
    ranAt,
    clean: output.includes("No interactive console-spawning tasks found"),
    repeatingOffenders,
    output: output.trim(),
  };
}

export interface TaskAction {
  readonly execute: string;
  readonly arguments: string;
}

/** What a registered task actually launches, straight from the scheduler. */
export function readTaskAction(taskName: string): TaskAction | null {
  let xml: string;
  try {
    xml = execFileSync("schtasks", ["/Query", "/TN", taskName, "/XML", "ONE"], {
      encoding: "utf-8",
      windowsHide: true,
    });
  } catch {
    return null;
  }
  // schtasks emits UTF-16, which arrives here as text riddled with NULs.
  const clean = xml.replaceAll("\u0000", "");
  const execute = /<Command>([^<]*)<\/Command>/u.exec(clean)?.[1]?.trim();
  const args = /<Arguments>([^<]*)<\/Arguments>/u.exec(clean)?.[1]?.trim() ?? "";
  return execute ? { execute, arguments: args } : null;
}

/** Does this task launch through the script host rather than a console program? */
export function taskLaunchesHidden(action: TaskAction | null): boolean {
  if (!action) return false;
  const leaf = action.execute.replaceAll('"', "").split(/[\\/]/u).pop()?.toLowerCase() ?? "";
  return leaf === "wscript.exe";
}

/** Task Scheduler only accepts UTF-16 XML. */
export function writeTaskXmlFile(file: string, xml: string): void {
  writeFileSync(file, `﻿${xml}`, "utf16le");
}

export function registerTaskFromXml(taskName: string, xmlFile: string): void {
  execFileSync("schtasks", ["/Create", "/TN", taskName, "/XML", xmlFile, "/F"], {
    stdio: "pipe",
    windowsHide: true,
  });
}

export function deleteTask(taskName: string): boolean {
  try {
    execFileSync("schtasks", ["/Delete", "/TN", taskName, "/F"], {
      stdio: "pipe",
      windowsHide: true,
    });
    return true;
  } catch {
    // silent-ok: not being registered is the state we wanted
    return false;
  }
}

export function taskExists(taskName: string): boolean {
  try {
    execFileSync("schtasks", ["/Query", "/TN", taskName], { stdio: "pipe", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * When should the machine get up?
 *
 * A moment or two after the limit lifts, and never in the past - Task Scheduler
 * will happily accept a boundary that has already gone by and then fire
 * immediately, which would waste the wake on nothing.
 */
export function wakeTimeFor(
  waitingUntil: string | null,
  now: Date,
  graceMs: number,
): Date | null {
  if (!waitingUntil) return null;
  const resetsAt = new Date(waitingUntil);
  if (!Number.isFinite(resetsAt.getTime())) return null;
  const target = new Date(resetsAt.getTime() + graceMs);
  if (target.getTime() <= now.getTime()) return null;
  return target;
}
