import { describe, expect, it } from "vite-plus/test";

import {
  isOwnedByLiveForeignBackend,
  readSessionOwnerPid,
  sessionOwnerLiveness,
  stampSessionOwner,
} from "./sessionOwner.ts";

const DEAD_PID = 424242;
const FOREIGN_PID = 999;

/** Nothing is alive unless the test says so; the real check is a syscall. */
const aliveOnly =
  (...pids: ReadonlyArray<number>) =>
  (pid: number) =>
    pids.includes(pid);

describe("stampSessionOwner", () => {
  it("stamps this process onto every write, payload or not", () => {
    expect(readSessionOwnerPid(stampSessionOwner(null))).toBe(process.pid);
    expect(readSessionOwnerPid(stampSessionOwner({ activeTurnId: "turn-1" }))).toBe(process.pid);
  });

  it("keeps the payload it was given", () => {
    expect(stampSessionOwner({ activeTurnId: "turn-1" })).toMatchObject({
      activeTurnId: "turn-1",
    });
  });
});

describe("readSessionOwnerPid", () => {
  it("reads nothing out of rows written before the stamp existed", () => {
    expect(readSessionOwnerPid({ activeTurnId: "turn-1" })).toBeNull();
    expect(readSessionOwnerPid(null)).toBeNull();
    expect(readSessionOwnerPid("not-a-payload")).toBeNull();
    expect(readSessionOwnerPid({ ownerPid: "1234" })).toBeNull();
    expect(readSessionOwnerPid({ ownerPid: 0 })).toBeNull();
  });
});

describe("sessionOwnerLiveness", () => {
  it("knows its own writes", () => {
    expect(sessionOwnerLiveness(stampSessionOwner(null))).toBe("self");
  });

  it("separates a running sibling backend from one that has exited", () => {
    expect(
      sessionOwnerLiveness({ ownerPid: FOREIGN_PID }, { isProcessAlive: aliveOnly(FOREIGN_PID) }),
    ).toBe("live");
    expect(sessionOwnerLiveness({ ownerPid: DEAD_PID }, { isProcessAlive: aliveOnly() })).toBe(
      "gone",
    );
  });

  it("admits it cannot tell for a row with no owner", () => {
    expect(sessionOwnerLiveness({ activeTurnId: "turn-1" })).toBe("unknown");
  });
});

describe("isOwnedByLiveForeignBackend", () => {
  it("is true only for a live process that is not this one", () => {
    expect(
      isOwnedByLiveForeignBackend(
        { ownerPid: FOREIGN_PID },
        { isProcessAlive: aliveOnly(FOREIGN_PID) },
      ),
    ).toBe(true);
    expect(
      isOwnedByLiveForeignBackend({ ownerPid: DEAD_PID }, { isProcessAlive: aliveOnly() }),
    ).toBe(false);
    expect(isOwnedByLiveForeignBackend(stampSessionOwner(null))).toBe(false);
    // A row from an older build must stay eligible for the callers that skip
    // foreign sessions, or they would skip every carried-over conversation.
    expect(isOwnedByLiveForeignBackend({ activeTurnId: "turn-1" })).toBe(false);
  });
});
