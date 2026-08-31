import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeConfigDirPath,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");
        const environment = {} satisfies NodeJS.ProcessEnv;

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).HOME).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath }, environment)).toBe(
          `claude:sessions:${path.join(resolved, ".claude", "projects")}`,
        );
        expect(
          yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath }, environment),
        ).toBe(`claude\0${resolved}\0${path.join(resolved, ".claude")}`);
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, {})).toBe(
          `claude:sessions:${path.join(resolved, ".claude", "projects")}`,
        );
      }),
    );
  });

  describe("CLAUDE_CONFIG_DIR", () => {
    it.effect("wins over the HOME override when resolving the config dir", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const configDir = "~/.claude-personal";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-personal");

        expect(
          yield* resolveClaudeConfigDirPath(
            { homePath: "~/.claude-work" },
            { CLAUDE_CONFIG_DIR: configDir },
          ),
        ).toBe(resolved);
      }),
    );

    it.effect("separates continuation for instances that differ only by config dir", () =>
      Effect.gen(function* () {
        const personal = yield* makeClaudeContinuationGroupKey(
          { homePath: "" },
          { CLAUDE_CONFIG_DIR: "~/.claude-personal" },
        );
        const work = yield* makeClaudeContinuationGroupKey(
          { homePath: "" },
          { CLAUDE_CONFIG_DIR: "~/.claude-dj" },
        );

        expect(personal).not.toBe(work);
      }),
    );

    it.effect("separates the capabilities cache for two accounts sharing one home", () =>
      Effect.gen(function* () {
        const personal = yield* makeClaudeCapabilitiesCacheKey(
          { binaryPath: "claude", homePath: "" },
          { CLAUDE_CONFIG_DIR: "~/.claude-personal" },
        );
        const work = yield* makeClaudeCapabilitiesCacheKey(
          { binaryPath: "claude", homePath: "" },
          { CLAUDE_CONFIG_DIR: "~/.claude-dj" },
        );

        expect(personal).not.toBe(work);
      }),
    );
  });
});
