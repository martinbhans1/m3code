import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_CONNECTION_HEARTBEAT,
  getHeartbeatDetectionWindowMs,
} from "./connectionHeartbeat.ts";

describe("DEFAULT_CONNECTION_HEARTBEAT", () => {
  it("tolerates more than one slow round trip", () => {
    expect(DEFAULT_CONNECTION_HEARTBEAT.maxMissedPongs).toBeGreaterThan(1);
  });

  it("still notices a dead socket within a reasonable window", () => {
    const windowMs = getHeartbeatDetectionWindowMs();

    expect(windowMs).toBeGreaterThanOrEqual(20_000);
    expect(windowMs).toBeLessThanOrEqual(60_000);
  });
});

describe("getHeartbeatDetectionWindowMs", () => {
  it("accounts for the ping that has not been answered yet", () => {
    expect(getHeartbeatDetectionWindowMs({ intervalMillis: 1_000, maxMissedPongs: 2 })).toBe(3_000);
  });
});
