import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  isProcessAlive,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
  readPersistedServerRuntimeState,
} from "./serverRuntimeState.ts";

const testLayer = Layer.empty.pipe(Layer.provideMerge(NodeServices.layer));

/**
 * Above any pid a real system hands out (Linux caps at 2^22 by default, Windows
 * pids are DWORDs allocated from the low end), so nothing can be listening on
 * it while the test runs.
 */
const NEVER_ALLOCATED_PID = 0x7fff_fffe;

/**
 * `isProcessAlive` and the runtime-state file are what stand between "dev and
 * the installed app share one state store" and silence: the boot path warns
 * only when that file names a process still running. A false negative here
 * turns the shared-database hazard back into something you discover hours
 * later as "Thread '<id>' does not exist".
 */
describe("isProcessAlive", () => {
  it("reports a live sibling process as alive", () => {
    // The runner that spawned this worker is a real, live process that is not
    // us — exactly the shape of the sibling backend the boot check looks for.
    expect(process.ppid).toBeGreaterThan(0);
    expect(isProcessAlive(process.ppid)).toBe(true);
  });

  it("reports a pid nothing is using as not alive", () => {
    expect(isProcessAlive(NEVER_ALLOCATED_PID)).toBe(false);
  });

  it("never reports the current process as a sibling", () => {
    // Own pid must read as "not alive" so a backend that restarts into its own
    // leftover runtime file does not warn about itself.
    expect(isProcessAlive(process.pid)).toBe(false);
  });
});

describe("readPersistedServerRuntimeState", () => {
  it.effect("round-trips the state a sibling check reads", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-",
      });
      const statePath = path.join(dir, "server-runtime.json");

      const written = yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1" },
        port: 13775,
      });
      yield* persistServerRuntimeState({ path: statePath, state: written });

      const read = yield* readPersistedServerRuntimeState(statePath);

      expect(Option.isSome(read)).toBe(true);
      const value = Option.getOrThrow(read);
      expect(value).toEqual(written);
      expect(value.pid).toBe(process.pid);
      expect(value.origin).toBe("http://127.0.0.1:13775");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("returns none for a missing file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-",
      });

      const read = yield* readPersistedServerRuntimeState(path.join(dir, "absent.json"));

      expect(Option.isNone(read)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("returns none for an unreadable file rather than failing the boot", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-",
      });
      const statePath = path.join(dir, "garbage.json");
      yield* fileSystem.writeFileString(statePath, "{not json");

      const read = yield* readPersistedServerRuntimeState(statePath);

      expect(Option.isNone(read)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
