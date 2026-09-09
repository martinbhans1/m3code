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
import { writeFileSync } from "node:fs";

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
  readonly scriptHost: string;
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
      <Command>${task.scriptHost}</Command>
      <Arguments>"${task.scriptPath}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * A window-less launcher for the scan.
 *
 * `wscript` with window style 0 is the only reliable way to run a console
 * command from Task Scheduler without a black box flashing over whatever is on
 * screen at the time.
 */
export function buildHiddenLauncherVbs(command: string): string {
  const escaped = command.replaceAll('"', '""');
  return [
    "' Written by usage-limit-watchdog install. Runs the scan with no console window.",
    "Set shell = CreateObject(\"WScript.Shell\")",
    `shell.Run "${escaped}", 0, False`,
    "",
  ].join("\r\n");
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
