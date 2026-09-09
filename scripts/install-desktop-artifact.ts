/**
 * install-desktop-artifact - Launch the most recent desktop installer.
 *
 * `dist:desktop:*` drops an installer in `release/`, and installing it means
 * finding that file by hand. This runs it instead, so a rebuild-and-install is
 * one command (and therefore one saved action) rather than a trip through the
 * file explorer.
 *
 * The installer shuts M3 Code down as its first act, which kills whatever
 * spawned this script. The child is therefore launched detached and unref'd:
 * it has to outlive its own parent to finish installing.
 */
// @effect-diagnostics nodeBuiltinImport:off - detached spawn is the whole point
import { spawn } from "node:child_process";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Command, Flag } from "effect/unstable/cli";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

class InstallScriptError extends Data.TaggedError("InstallScriptError")<{
  readonly message: string;
}> {}

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

/** Installer extension and default build target per platform. */
const PLATFORM_INSTALLER = {
  win32: { extension: ".exe", buildTarget: "nsis", buildPlatform: "win" },
  darwin: { extension: ".dmg", buildTarget: "dmg", buildPlatform: "mac" },
  linux: { extension: ".AppImage", buildTarget: "AppImage", buildPlatform: "linux" },
} as const satisfies Partial<
  Record<
    NodeJS.Platform,
    { readonly extension: string; readonly buildTarget: string; readonly buildPlatform: string }
  >
>;

type SupportedPlatform = keyof typeof PLATFORM_INSTALLER;

const isSupportedPlatform = (platform: NodeJS.Platform): platform is SupportedPlatform =>
  platform in PLATFORM_INSTALLER;

const resolvePlatformInstaller = Effect.gen(function* () {
  const hostPlatform = yield* HostProcessPlatform;
  if (!isSupportedPlatform(hostPlatform)) {
    return yield* new InstallScriptError({
      message: `No desktop installer is produced for platform '${hostPlatform}'.`,
    });
  }
  return PLATFORM_INSTALLER[hostPlatform];
});

/**
 * The newest installer in the release directory. Newest by modification time
 * rather than by version string, because a local rebuild of the same version is
 * the common case here — the version rarely moves between builds.
 */
const findLatestInstaller = Effect.fn("findLatestInstaller")(function* (input: {
  readonly releaseDir: string;
  readonly extension: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const exists = yield* fs.exists(input.releaseDir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return yield* new InstallScriptError({
      message: `No release directory at ${input.releaseDir}. Build one first, for example with 'pnpm dist:desktop:win'.`,
    });
  }

  const entries = yield* fs.readDirectory(input.releaseDir);
  const candidates = entries.filter((entry) => entry.endsWith(input.extension));
  if (candidates.length === 0) {
    return yield* new InstallScriptError({
      message: `No ${input.extension} installer in ${input.releaseDir}. Build one first, for example with 'pnpm dist:desktop:win'.`,
    });
  }

  const withTimes = yield* Effect.forEach(candidates, (entry) => {
    const filePath = path.join(input.releaseDir, entry);
    return fs.stat(filePath).pipe(
      Effect.map((stat) => ({
        filePath,
        modifiedAt: Option.match(stat.mtime, {
          onNone: () => 0,
          onSome: (mtime) => mtime.getTime(),
        }),
      })),
    );
  });

  const [latest] = withTimes.toSorted((left, right) => right.modifiedAt - left.modifiedAt);
  if (latest === undefined) {
    return yield* new InstallScriptError({
      message: `Could not stat any installer in ${input.releaseDir}.`,
    });
  }
  return latest.filePath;
});

/** Run the build script to completion, streaming its output. */
const runBuild = Effect.fn("runBuild")(function* (input: {
  readonly repoRoot: string;
  readonly buildPlatform: string;
  readonly buildTarget: string;
}) {
  const path = yield* Path.Path;
  const scriptPath = path.join(input.repoRoot, "scripts", "build-desktop-artifact.ts");

  yield* Effect.log("[install-desktop] Building a fresh artifact first...");

  const exitCode = yield* Effect.callback<number>((resume) => {
    const child = spawn(
      process.execPath,
      [scriptPath, "--platform", input.buildPlatform, "--target", input.buildTarget],
      { cwd: input.repoRoot, stdio: "inherit", windowsHide: true },
    );
    child.on("error", () => resume(Effect.succeed(1)));
    child.on("close", (code) => resume(Effect.succeed(code ?? 1)));
  });

  if (exitCode !== 0) {
    return yield* new InstallScriptError({
      message: `Build failed with exit code ${exitCode}; nothing was installed.`,
    });
  }
});

/**
 * Hand the installer off to the OS and return immediately. Nothing is awaited:
 * the installer's first move is to stop the running app, which takes this
 * process down with it.
 */
const launchInstaller = Effect.fn("launchInstaller")(function* (input: {
  readonly installerPath: string;
  readonly silent: boolean;
  readonly platform: SupportedPlatform;
}) {
  // The NSIS one-click installer takes /S to skip its progress UI. The macOS
  // and Linux artifacts are a mountable image and a self-contained binary, so
  // there is nothing equivalent to pass.
  const args = input.silent && input.platform === "win32" ? ["/S"] : [];
  const command = input.platform === "darwin" ? "open" : input.installerPath;
  const commandArgs = input.platform === "darwin" ? [input.installerPath] : args;

  yield* Effect.sync(() => {
    const child = spawn(command, commandArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
  });
});

const installDesktopArtifactCli = Command.make("install-desktop-artifact", {
  installerPath: Flag.string("path").pipe(
    Flag.withDescription("Install this specific artifact instead of the newest one."),
    Flag.optional,
  ),
  build: Flag.boolean("build").pipe(
    Flag.withDescription("Build a fresh artifact for this platform before installing."),
    Flag.optional,
  ),
  silent: Flag.boolean("silent").pipe(
    Flag.withDescription("Windows only: run the installer without its progress window."),
    Flag.optional,
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Report which installer would run, without running it."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Run the newest desktop installer from release/. This restarts M3 Code and ends any conversation running inside it.",
  ),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = yield* RepoRoot;
      const hostPlatform = yield* HostProcessPlatform;
      const platformInstaller = yield* resolvePlatformInstaller;
      const releaseDir = path.join(repoRoot, "release");

      if (Option.getOrElse(input.build, () => false)) {
        yield* runBuild({
          repoRoot,
          buildPlatform: platformInstaller.buildPlatform,
          buildTarget: platformInstaller.buildTarget,
        });
      }

      const installerPath = yield* Option.match(input.installerPath, {
        onNone: () => findLatestInstaller({ releaseDir, extension: platformInstaller.extension }),
        onSome: (value) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const resolved = path.resolve(repoRoot, value);
            const exists = yield* fs.exists(resolved).pipe(Effect.orElseSucceed(() => false));
            if (!exists) {
              return yield* new InstallScriptError({ message: `No installer at ${resolved}.` });
            }
            return resolved;
          }),
      });

      if (Option.getOrElse(input.dryRun, () => false)) {
        yield* Effect.log("[install-desktop] Would run installer (dry run).").pipe(
          Effect.annotateLogs({ installerPath }),
        );
        return;
      }

      yield* Effect.log(
        "[install-desktop] Launching installer. M3 Code will close and reopen; any conversation running inside it ends here.",
      ).pipe(Effect.annotateLogs({ installerPath }));

      yield* launchInstaller({
        installerPath,
        silent: Option.getOrElse(input.silent, () => false),
        platform: hostPlatform as SupportedPlatform,
      });
    }),
  ),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main) {
  Command.run(installDesktopArtifactCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
