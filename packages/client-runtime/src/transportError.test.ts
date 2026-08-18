import { describe, expect, it } from "vite-plus/test";

import {
  isInterruptError,
  isInterruptErrorMessage,
  isTransportConnectionErrorMessage,
  sanitizeThreadErrorMessage,
  TransportInterruptedError,
} from "./transportError.ts";

describe("isTransportConnectionErrorMessage", () => {
  it("returns true for SocketCloseError", () => {
    expect(isTransportConnectionErrorMessage("SocketCloseError: connection reset")).toBe(true);
  });

  it("returns true for SocketOpenError", () => {
    expect(isTransportConnectionErrorMessage("SocketOpenError: ECONNREFUSED")).toBe(true);
  });

  it("returns true for React Native disconnected socket errors", () => {
    expect(
      isTransportConnectionErrorMessage(
        "The operation couldn't be completed. Socket is not connected",
      ),
    ).toBe(true);
  });

  it("returns true for the T3 server WebSocket message", () => {
    expect(isTransportConnectionErrorMessage("Unable to connect to the T3 server WebSocket.")).toBe(
      true,
    );
  });

  it("returns true for ping timeout", () => {
    expect(isTransportConnectionErrorMessage("ping timeout")).toBe(true);
  });

  it("does not treat a cancelled Effect fiber as a connection failure", () => {
    expect(isTransportConnectionErrorMessage("All fibers interrupted without error")).toBe(false);
    expect(isTransportConnectionErrorMessage("Transport request interrupted")).toBe(false);
  });

  it("returns false for business logic errors", () => {
    expect(isTransportConnectionErrorMessage("Thread not found")).toBe(false);
    expect(isTransportConnectionErrorMessage("Invalid model selection")).toBe(false);
  });

  it("returns false for null, undefined, and empty strings", () => {
    expect(isTransportConnectionErrorMessage(null)).toBe(false);
    expect(isTransportConnectionErrorMessage(undefined)).toBe(false);
    expect(isTransportConnectionErrorMessage("")).toBe(false);
    expect(isTransportConnectionErrorMessage("   ")).toBe(false);
  });
});

describe("isInterruptError", () => {
  it("returns true for TransportInterruptedError", () => {
    expect(isInterruptError(new TransportInterruptedError())).toBe(true);
  });

  it("returns true for Effect's InterruptError name", () => {
    const error = new Error("All fibers interrupted without error");
    error.name = "InterruptError";
    expect(isInterruptError(error)).toBe(true);
  });

  it("returns true for Cause.squash's interrupt-only message", () => {
    expect(isInterruptError(new Error("All fibers interrupted without error"))).toBe(true);
    expect(isInterruptError("All fibers interrupted without error")).toBe(true);
    expect(isInterruptErrorMessage("InterruptError: All fibers interrupted without error")).toBe(
      true,
    );
  });

  it("returns false for connection and business errors", () => {
    expect(isInterruptError(new Error("SocketCloseError: connection reset"))).toBe(false);
    expect(isInterruptError(new Error("Thread not found"))).toBe(false);
    expect(isInterruptError(null)).toBe(false);
  });
});

describe("sanitizeThreadErrorMessage", () => {
  it("strips transport errors", () => {
    expect(sanitizeThreadErrorMessage("SocketCloseError: oops")).toBeNull();
  });

  it("strips cancelled-fiber interrupts so they never reach the thread banner", () => {
    expect(sanitizeThreadErrorMessage("All fibers interrupted without error")).toBeNull();
    expect(sanitizeThreadErrorMessage("Transport request interrupted")).toBeNull();
  });

  it("preserves non-transport errors", () => {
    expect(sanitizeThreadErrorMessage("Thread not found")).toBe("Thread not found");
    expect(sanitizeThreadErrorMessage("Select a base branch before sending.")).toBe(
      "Select a base branch before sending.",
    );
  });

  it("returns null for null/undefined", () => {
    expect(sanitizeThreadErrorMessage(null)).toBeNull();
    expect(sanitizeThreadErrorMessage(undefined)).toBeNull();
  });
});
