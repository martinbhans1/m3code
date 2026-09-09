// @effect-diagnostics globalDate:off - Fixtures for a standalone watchdog process.
import { assert, it } from "@effect/vitest";

import { buildHiddenLauncherVbs, buildTaskXml, toTaskBoundary, wakeTimeFor } from "./watchdog-schedule.ts";

const BASE = {
  description: "test",
  userId: "DOMAIN\\user",
  scriptHost: "C:\\Windows\\System32\\wscript.exe",
  scriptPath: "C:\\Users\\Martin\\.t3\\watchdog\\run-scan.vbs",
  startBoundary: "2026-09-09T03:43:00",
} as const;

it("lets the heartbeat run on battery but never wake the machine", () => {
  const xml = buildTaskXml({ ...BASE, repeatEveryMinutes: 5, wakeToRun: false });
  assert.include(xml, "<Interval>PT5M</Interval>");
  assert.include(xml, "<WakeToRun>false</WakeToRun>");
  assert.include(xml, "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
  assert.include(xml, "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
  assert.include(xml, "<StartWhenAvailable>true</StartWhenAvailable>");
});

it("lets the single-shot task wake the machine, and gives it no repetition", () => {
  const xml = buildTaskXml({ ...BASE, wakeToRun: true });
  assert.include(xml, "<WakeToRun>true</WakeToRun>");
  assert.notInclude(xml, "<Repetition>");
  assert.include(xml, "<StartBoundary>2026-09-09T03:43:00</StartBoundary>");
});

it("runs through the script host so no console window appears", () => {
  const xml = buildTaskXml({ ...BASE, repeatEveryMinutes: 5, wakeToRun: false });
  assert.include(xml, "<Command>C:\\Windows\\System32\\wscript.exe</Command>");
  assert.include(xml, "run-scan.vbs");
});

it("hides the window it launches", () => {
  const vbs = buildHiddenLauncherVbs('"C:\\path with spaces\\run-scan.cmd"');
  assert.include(vbs, 'shell.Run """C:\\path with spaces\\run-scan.cmd""", 0, False');
});

it("writes task boundaries as local wall-clock time, which is what the scheduler expects", () => {
  const local = new Date(2026, 8, 9, 3, 43, 5);
  assert.equal(toTaskBoundary(local), "2026-09-09T03:43:05");
});

it("arms the wake shortly after the reset, and not at all when nothing is waiting", () => {
  const now = new Date("2026-09-09T01:20:00.000Z");
  const armed = wakeTimeFor("2026-09-09T01:40:00.000Z", now, 3 * 60_000);
  assert.equal(armed?.toISOString(), "2026-09-09T01:43:00.000Z");
  assert.isNull(wakeTimeFor(null, now, 3 * 60_000));
});

it("refuses to arm a wake for a moment that has already gone by", () => {
  const now = new Date("2026-09-09T02:00:00.000Z");
  assert.isNull(wakeTimeFor("2026-09-09T01:40:00.000Z", now, 3 * 60_000));
});
