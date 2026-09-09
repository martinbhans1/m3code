import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/require-windows-hide");

describe("t3code/require-windows-hide", () => {
  rule.valid(
    "allows a spawn that hides its window",
    `
      import { spawn } from "node:child_process";

      export const child = spawn("git", ["status"], { cwd: ".", windowsHide: true });
    `,
  );

  rule.valid(
    "allows a deliberate visible window, because an installer has to be seen",
    `
      import { spawn } from "node:child_process";

      export const installer = spawn(installerPath, [], { detached: true, windowsHide: false });
    `,
  );

  rule.valid(
    "allows options assembled elsewhere and spread in",
    `
      import { execFileSync } from "node:child_process";

      export const output = execFileSync("git", ["status"], { ...baseOptions });
    `,
  );

  rule.valid(
    "leaves unrelated calls alone",
    `
      const match = /a(b)c/.exec("abc");
      export const inner = match?.[1];
    `,
  );

  rule.invalid(
    "reports a spawn with no options at all",
    `
      import { execFileSync } from "node:child_process";

      export const output = execFileSync("mkfifo", [path]);
    `,
    (output) => {
      assert.match(output, /must pass windowsHide explicitly/);
    },
  );

  rule.invalid(
    "reports options that never mention the flag",
    `
      import { spawn } from "node:child_process";

      export const child = spawn("electron", args, { stdio: "inherit", cwd: dir });
    `,
  );

  rule.invalid(
    "reports namespace imports too",
    `
      import * as childProcess from "node:child_process";

      export const result = childProcess.spawnSync("git", args, { encoding: "utf8" });
    `,
  );

  rule.invalid(
    "reports renamed imports",
    `
      import { execFile as runFile } from "node:child_process";

      export const output = runFile("pwsh.exe", args, { encoding: "utf8" });
    `,
  );

  rule.invalid(
    "reports a spawn function injected as a parameter, which is how the last one hid",
    `
      export function readEnvironment(execFile = defaultExecFile) {
        return execFile("powershell.exe", args, { encoding: "utf8", timeout: 5000 });
      }
    `,
    (output) => {
      assert.match(output, /execFile\(\) must pass windowsHide/);
    },
  );
});
