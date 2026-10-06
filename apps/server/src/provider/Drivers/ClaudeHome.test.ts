import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeSessionTranscriptExists,
  encodeClaudeProjectDirName,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeConfigDirPath,
  resolveClaudeHomePath,
  resolveClaudeSessionTranscriptPath,
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
  describe("session transcripts", () => {
    it("encodes a workspace path the way Claude Code names its project folder", () => {
      expect(
        encodeClaudeProjectDirName(
          String.raw`C:\Users\Martin\Documents\GitHub\dealjourney\website`,
        ),
      ).toBe("C--Users-Martin-Documents-GitHub-dealjourney-website");
      // A leading dot is a separator too, which is why `.t3` gains a dash.
      expect(encodeClaudeProjectDirName(String.raw`C:\Users\Martin\.t3\userdata`)).toBe(
        "C--Users-Martin--t3-userdata",
      );
    });

    it.effect("names the transcript a resume would read", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const configDir = path.join(NodeOS.tmpdir(), "m3code-claude-home-test");
        const transcriptPath = yield* resolveClaudeSessionTranscriptPath(
          {
            config: { homePath: "" },
            cwd: "/workspace/project",
            sessionId: "ace4f745-cada-4244-9de7-fc0b44c9e845",
          },
          { CLAUDE_CONFIG_DIR: configDir },
        );

        expect(transcriptPath).toBe(
          path.join(
            configDir,
            "projects",
            encodeClaudeProjectDirName("/workspace/project"),
            "ace4f745-cada-4244-9de7-fc0b44c9e845.jsonl",
          ),
        );
      }),
    );

    it.effect("reports a deleted transcript as unresumable and a present one as resumable", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const configDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "m3code-claude-config-",
        });
        const cwd = path.join(configDir, "workspace");
        const projectDir = path.join(configDir, "projects", encodeClaudeProjectDirName(cwd));
        yield* fileSystem.makeDirectory(projectDir, { recursive: true });

        const present = "11111111-1111-4111-8111-111111111111";
        const deleted = "22222222-2222-4222-8222-222222222222";
        yield* fileSystem.writeFileString(path.join(projectDir, `${present}.jsonl`), "{}");

        expect(
          yield* claudeSessionTranscriptExists(
            { config: { homePath: "" }, cwd, sessionId: present },
            { CLAUDE_CONFIG_DIR: configDir },
          ),
        ).toBe(true);
        expect(
          yield* claudeSessionTranscriptExists(
            { config: { homePath: "" }, cwd, sessionId: deleted },
            { CLAUDE_CONFIG_DIR: configDir },
          ),
        ).toBe(false);
      }).pipe(Effect.scoped),
    );
  });
});
