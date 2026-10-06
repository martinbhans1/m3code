import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  CLAUDE_SESSION_RETENTION_FLOOR_DAYS,
  ensureClaudeSessionRetention,
} from "./ClaudeSessionRetention.ts";

const makeConfigDir = Effect.fn("makeConfigDir")(function* (settingsJson?: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "m3code-claude-retention-",
  });
  const settingsPath = path.join(configDir, "settings.json");
  if (settingsJson !== undefined) {
    yield* fileSystem.writeFileString(settingsPath, settingsJson);
  }
  return { configDir, settingsPath };
});

const readSettings = Effect.fn("readSettings")(function* (settingsPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem.readFileString(settingsPath);
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  return JSON.parse(contents) as Record<string, unknown>;
});

it.layer(NodeServices.layer)("ClaudeSessionRetention", (it) => {
  describe("ensureClaudeSessionRetention", () => {
    it.effect("raises the default 30-day cleanup to the floor, keeping other settings", () =>
      Effect.gen(function* () {
        const { configDir, settingsPath } = yield* makeConfigDir(
          `{\n  "theme": "dark",\n  "hooks": { "Stop": [] }\n}\n`,
        );

        const outcome = yield* ensureClaudeSessionRetention(
          { homePath: "" },
          { CLAUDE_CONFIG_DIR: configDir },
        );

        expect(outcome.kind).toBe("raised");
        const settings = yield* readSettings(settingsPath);
        expect(settings.cleanupPeriodDays).toBe(CLAUDE_SESSION_RETENTION_FLOOR_DAYS);
        expect(settings.theme).toBe("dark");
        expect(settings.hooks).toEqual({ Stop: [] });
      }).pipe(Effect.scoped),
    );

    it.effect("creates the setting for a config dir that has no settings file yet", () =>
      Effect.gen(function* () {
        const { configDir, settingsPath } = yield* makeConfigDir();

        const outcome = yield* ensureClaudeSessionRetention(
          { homePath: "" },
          { CLAUDE_CONFIG_DIR: configDir },
        );

        expect(outcome.kind).toBe("raised");
        expect((yield* readSettings(settingsPath)).cleanupPeriodDays).toBe(
          CLAUDE_SESSION_RETENTION_FLOOR_DAYS,
        );
      }).pipe(Effect.scoped),
    );

    it.effect("raises an explicit value that is below the floor", () =>
      Effect.gen(function* () {
        const { configDir, settingsPath } = yield* makeConfigDir(`{ "cleanupPeriodDays": 14 }`);

        const outcome = yield* ensureClaudeSessionRetention(
          { homePath: "" },
          { CLAUDE_CONFIG_DIR: configDir },
        );

        expect(outcome).toMatchObject({ kind: "raised", previousDays: 14 });
        expect((yield* readSettings(settingsPath)).cleanupPeriodDays).toBe(
          CLAUDE_SESSION_RETENTION_FLOOR_DAYS,
        );
      }).pipe(Effect.scoped),
    );

    it.effect("leaves a value already at or above the floor untouched", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const original = `{"cleanupPeriodDays": 99999, "theme": "light"}`;
        const { configDir, settingsPath } = yield* makeConfigDir(original);

        const outcome = yield* ensureClaudeSessionRetention(
          { homePath: "" },
          { CLAUDE_CONFIG_DIR: configDir },
        );

        expect(outcome).toMatchObject({ kind: "already-sufficient", days: 99999 });
        // Byte-identical: a file we had no reason to touch is not rewritten.
        expect(yield* fileSystem.readFileString(settingsPath)).toBe(original);
      }).pipe(Effect.scoped),
    );

    it.effect("refuses to rewrite a settings file it cannot parse", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const original = `{ "theme": "dark", oops`;
        const { configDir, settingsPath } = yield* makeConfigDir(original);

        const outcome = yield* ensureClaudeSessionRetention(
          { homePath: "" },
          { CLAUDE_CONFIG_DIR: configDir },
        );

        expect(outcome.kind).toBe("skipped");
        expect(yield* fileSystem.readFileString(settingsPath)).toBe(original);
      }).pipe(Effect.scoped),
    );

    it.effect("applies to whichever config dir the instance actually reads", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "m3code-claude-home-",
        });
        const accountConfigDir = path.join(home, ".claude-second-account");
        yield* fileSystem.makeDirectory(accountConfigDir, { recursive: true });

        // No CLAUDE_CONFIG_DIR: the floor lands in `<home>/.claude`.
        const viaHome = yield* ensureClaudeSessionRetention({ homePath: home }, {});
        expect(viaHome).toMatchObject({
          kind: "raised",
          configDir: path.join(path.resolve(home), ".claude"),
        });

        // With one: it follows the env var, which is how a second account is run.
        const viaEnv = yield* ensureClaudeSessionRetention(
          { homePath: home },
          { CLAUDE_CONFIG_DIR: accountConfigDir },
        );
        expect(viaEnv).toMatchObject({ kind: "raised" });
        expect(
          (yield* readSettings(path.join(accountConfigDir, "settings.json"))).cleanupPeriodDays,
        ).toBe(CLAUDE_SESSION_RETENTION_FLOOR_DAYS);
      }).pipe(Effect.scoped),
    );
  });
});
