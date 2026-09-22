import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { authenticateClaude } from "./ClaudeProvider.ts";

const encoder = new TextEncoder();
const settings: ClaudeSettings = {
  enabled: true,
  binaryPath: "claude",
  homePath: "C:/accounts/claude-personal",
  customModels: [],
  launchArgs: "",
};

function handle(code: number, stderr = "") {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.make(encoder.encode(stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("Claude authentication", () => {
  it.effect("runs Claude login with the selected instance HOME", () => {
    const commands: Array<{
      readonly args: ReadonlyArray<string>;
      readonly env: NodeJS.ProcessEnv | undefined;
    }> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      const captured = command as unknown as {
        readonly args: ReadonlyArray<string>;
        readonly options?: { readonly env?: NodeJS.ProcessEnv };
      };
      commands.push({ args: captured.args, env: captured.options?.env });
      return Effect.succeed(handle(0));
    });

    return authenticateClaude(settings, { PATH: process.env.PATH }).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
      Effect.andThen(
        Effect.sync(() => {
          assert.deepStrictEqual(commands[0]?.args, ["auth", "login"]);
          assert.equal(commands[0]?.env?.HOME, "C:\\accounts\\claude-personal");
        }),
      ),
    );
  });
});
