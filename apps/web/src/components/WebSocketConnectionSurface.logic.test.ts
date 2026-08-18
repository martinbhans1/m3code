import { describe, expect, it } from "vite-plus/test";

import type { WsConnectionStatus } from "../rpc/wsConnectionState";
import {
  getConnectionNoticeDelayMs,
  getConnectionNoticeRemainingMs,
  OFFLINE_NOTICE_GRACE_MS,
  RECONNECT_NOTICE_GRACE_MS,
  shouldAutoReconnect,
  shouldRestartStalledReconnect,
} from "./WebSocketConnectionSurface";

function makeStatus(overrides: Partial<WsConnectionStatus> = {}): WsConnectionStatus {
  return {
    attemptCount: 0,
    closeCode: null,
    closeReason: null,
    connectionLabel: null,
    connectedAt: null,
    disconnectedAt: null,
    hasConnected: false,
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    online: true,
    phase: "idle",
    reconnectAttemptCount: 0,
    reconnectMaxAttempts: null,
    reconnectPhase: "idle",
    socketUrl: null,
    ...overrides,
  };
}

describe("WebSocketConnectionSurface.logic", () => {
  it("forces reconnect on online when the app was offline", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          disconnectedAt: "2026-04-03T20:00:00.000Z",
          online: false,
          phase: "disconnected",
        }),
        "online",
      ),
    ).toBe(true);
  });

  it("forces reconnect on focus only for previously connected disconnected states", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "waiting",
        }),
        "focus",
      ),
    ).toBe(true);

    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: false,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 1,
          reconnectPhase: "waiting",
        }),
        "focus",
      ),
    ).toBe(false);
  });

  it("forces reconnect on focus for exhausted reconnect loops", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 8,
          reconnectPhase: "exhausted",
        }),
        "focus",
      ),
    ).toBe(true);
  });

  it("restarts a stalled reconnect window after the scheduled retry time passes", () => {
    expect(
      shouldRestartStalledReconnect(
        makeStatus({
          hasConnected: true,
          nextRetryAt: "2026-04-03T20:00:01.000Z",
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "waiting",
        }),
        "2026-04-03T20:00:01.000Z",
      ),
    ).toBe(true);

    expect(
      shouldRestartStalledReconnect(
        makeStatus({
          hasConnected: true,
          nextRetryAt: "2026-04-03T20:00:01.000Z",
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "attempting",
        }),
        "2026-04-03T20:00:01.000Z",
      ),
    ).toBe(false);
  });
});

describe("connection notice grace period", () => {
  const disconnectedAt = "2026-04-03T20:00:00.000Z";
  const disconnectedAtMs = new Date(disconnectedAt).getTime();

  it("announces nothing while connected", () => {
    expect(getConnectionNoticeDelayMs(makeStatus({ phase: "connected" }))).toBeNull();
  });

  it("holds a reconnect back until the gap outlives the grace window", () => {
    const status = makeStatus({
      disconnectedAt,
      hasConnected: true,
      phase: "disconnected",
      reconnectAttemptCount: 1,
      reconnectPhase: "waiting",
    });

    expect(getConnectionNoticeDelayMs(status)).toBe(RECONNECT_NOTICE_GRACE_MS);
    expect(getConnectionNoticeRemainingMs(status, disconnectedAtMs + 1_000)).toBe(
      RECONNECT_NOTICE_GRACE_MS - 1_000,
    );
    expect(
      getConnectionNoticeRemainingMs(status, disconnectedAtMs + RECONNECT_NOTICE_GRACE_MS),
    ).toBe(0);
  });

  it("uses a shorter window for a dropped network than a dropped socket", () => {
    const status = makeStatus({
      disconnectedAt,
      hasConnected: true,
      online: false,
      phase: "disconnected",
    });

    expect(getConnectionNoticeDelayMs(status)).toBe(OFFLINE_NOTICE_GRACE_MS);
    expect(OFFLINE_NOTICE_GRACE_MS).toBeLessThan(RECONNECT_NOTICE_GRACE_MS);
  });

  it("announces terminal states immediately", () => {
    expect(
      getConnectionNoticeDelayMs(
        makeStatus({ disconnectedAt, hasConnected: false, phase: "disconnected" }),
      ),
    ).toBe(0);

    expect(
      getConnectionNoticeDelayMs(
        makeStatus({
          disconnectedAt,
          hasConnected: true,
          phase: "disconnected",
          reconnectPhase: "exhausted",
        }),
      ),
    ).toBe(0);
  });
});
