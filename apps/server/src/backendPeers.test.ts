// @effect-diagnostics nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  hasLiveSiblingBackend,
  registerBackendPeer,
  resetBackendPeers,
  unregisterBackendPeer,
} from "./backendPeers.ts";

const NOW = "2026-09-17T16:00:00.000Z";
const DEAD_PID = 424242;

const makePeersDir = () => {
  const dir = join(mkdtempSync(join(tmpdir(), "t3-backend-peers-")), "backends");
  mkdirSync(dir, { recursive: true });
  return dir;
};

afterEach(() => {
  unregisterBackendPeer();
  resetBackendPeers();
});

describe("backendPeers", () => {
  it("does not mistake its own entry for a neighbour", () => {
    registerBackendPeer(makePeersDir(), NOW);
    expect(hasLiveSiblingBackend()).toBe(false);
  });

  it("sees a backend that is still running", () => {
    const dir = makePeersDir();
    // Another live process: the test runner's own parent will do.
    writeFileSync(
      join(dir, `${process.ppid}.json`),
      JSON.stringify({ pid: process.ppid, startedAt: NOW }),
    );
    registerBackendPeer(dir, NOW);
    expect(hasLiveSiblingBackend()).toBe(true);
  });

  it("sweeps an entry left behind by a backend that was killed", () => {
    const dir = makePeersDir();
    writeFileSync(join(dir, `${DEAD_PID}.json`), JSON.stringify({ pid: DEAD_PID, startedAt: NOW }));
    registerBackendPeer(dir, NOW);
    expect(hasLiveSiblingBackend()).toBe(false);
  });

  it("reports nothing before this backend has registered", () => {
    expect(hasLiveSiblingBackend()).toBe(false);
  });
});
