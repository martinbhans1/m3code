// @effect-diagnostics globalDate:off - Fixtures for a standalone watchdog process.
import { assert, it } from "@effect/vitest";

import { parseUsageLimitSignal } from "./usage-limit-signal.ts";

/** 2026-09-08 23:15 Europe/Oslo (CEST, UTC+2) - the night the supervisor died. */
const FAILED_AT = new Date("2026-09-08T21:15:00.000Z");

it("reads the Claude session-limit wording and resolves the next occurrence of the reset", () => {
  const signal = parseUsageLimitSignal(
    "You've hit your session limit · resets 3:40am (Europe/Oslo)",
    FAILED_AT,
  );
  assert.isNotNull(signal);
  assert.equal(signal?.dialect, "claude-session-limit");
  assert.equal(signal?.timeZone, "Europe/Oslo");
  assert.isFalse(signal?.timeZoneAssumed);
  // 03:40 Oslo the following morning is 01:40 UTC.
  assert.equal(signal?.resetsAt.toISOString(), "2026-09-09T01:40:00.000Z");
});

it("accepts a reset named without minutes", () => {
  const signal = parseUsageLimitSignal(
    "You've hit your session limit · resets 10pm (Europe/Oslo)",
    FAILED_AT,
  );
  assert.equal(signal?.resetsAt.toISOString(), "2026-09-09T20:00:00.000Z");
});

it("keeps a reset later the same day on the same day", () => {
  const morning = new Date("2026-09-08T06:00:00.000Z");
  const signal = parseUsageLimitSignal(
    "You've hit your session limit · resets 12:50pm (Europe/Oslo)",
    morning,
  );
  assert.equal(signal?.resetsAt.toISOString(), "2026-09-08T10:50:00.000Z");
});

it("reads the Codex wording, which names a retry time and no zone", () => {
  const signal = parseUsageLimitSignal(
    "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 1:41 PM.",
    FAILED_AT,
  );
  assert.equal(signal?.dialect, "codex-usage-limit");
  assert.isTrue(signal?.timeZoneAssumed);
  assert.isNotNull(signal?.resetsAt);
});

it("resolves midnight-crossing resets across a daylight-saving change", () => {
  // 2026-10-25 is the European autumn change: 03:00 CEST becomes 02:00 CET.
  const beforeChange = new Date("2026-10-24T23:30:00.000Z");
  const signal = parseUsageLimitSignal(
    "You've hit your session limit · resets 4:00am (Europe/Oslo)",
    beforeChange,
  );
  // 04:00 Oslo on the 25th is CET (UTC+1), so 03:00 UTC.
  assert.equal(signal?.resetsAt.toISOString(), "2026-10-25T03:00:00.000Z");
});

it("refuses everything that is not a usage limit, however it failed", () => {
  const notLimits = [
    "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.",
    "Selected model is at capacity. Please try a different model.",
    "Failed to authenticate: OAuth session expired and could not be refreshed",
    "Provider adapter process error (claudeAgent): Claude Code process exited with code 1073807364",
    "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
    "No conversation found with session ID: cfc858fa-70c5-45fe-9309-c18d482737c1",
    "",
    null,
    undefined,
  ];
  for (const message of notLimits) {
    assert.isNull(parseUsageLimitSignal(message, FAILED_AT), `should refuse: ${String(message)}`);
  }
});

it("refuses a limit message whose reset time it cannot read", () => {
  assert.isNull(parseUsageLimitSignal("You've hit your session limit", FAILED_AT));
  assert.isNull(
    parseUsageLimitSignal("You've hit your weekly limit · resets Wednesday", FAILED_AT),
  );
  assert.isNull(
    parseUsageLimitSignal("You've hit your session limit · resets 19:40 (Europe/Oslo)", FAILED_AT),
  );
});

it("falls back to host local time when the named zone is unusable, and says so", () => {
  const signal = parseUsageLimitSignal(
    "You've hit your session limit · resets 3:40am (Middle/Earth)",
    FAILED_AT,
  );
  assert.isNotNull(signal);
  assert.isNull(signal?.timeZone);
  assert.isTrue(signal?.timeZoneAssumed);
});
