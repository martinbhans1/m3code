const TRANSPORT_ERROR_PATTERNS = [
  /\bSocketCloseError\b/i,
  /\bSocketOpenError\b/i,
  /\bSocket is not connected\b/i,
  /Unable to connect to the T3 server WebSocket\./i,
  /\bping timeout\b/i,
] as const;

const EFFECT_INTERRUPT_MESSAGE_PATTERN = /\bAll fibers interrupted without error\b/i;
const TRANSPORT_INTERRUPTED_MESSAGE = "Transport request interrupted";

/**
 * Thrown when an in-flight transport Effect is interrupted (session replace,
 * dispose, or scope teardown) rather than failing with a typed error.
 */
export class TransportInterruptedError extends Error {
  readonly _tag = "TransportInterruptedError";

  constructor(message = TRANSPORT_INTERRUPTED_MESSAGE) {
    super(message);
    this.name = "TransportInterruptedError";
  }
}

/**
 * Test whether an error message originates from a transport-level connection
 * failure (socket close, socket open, ping timeout, etc.) rather than a
 * business-logic error.
 */
export function isTransportConnectionErrorMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string") {
    return false;
  }

  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
}

export function isInterruptErrorMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string") {
    return false;
  }

  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  return (
    EFFECT_INTERRUPT_MESSAGE_PATTERN.test(normalizedMessage) ||
    normalizedMessage === TRANSPORT_INTERRUPTED_MESSAGE
  );
}

/**
 * True for a cancelled transport fiber: our tagged interrupt, Effect's
 * `InterruptError`, or the string `Cause.squash` invents for interrupt-only
 * causes.
 */
export function isInterruptError(error: unknown): boolean {
  if (error instanceof TransportInterruptedError) {
    return true;
  }

  if (error instanceof Error) {
    if (error.name === "InterruptError") {
      return true;
    }
    return isInterruptErrorMessage(error.message);
  }

  return typeof error === "string" && isInterruptErrorMessage(error);
}

/**
 * Strip transport connection errors and cancelled-fiber interrupts from
 * user-facing error messages. Returns `null` so the UI can distinguish those
 * from real business-logic errors.
 */
export function sanitizeThreadErrorMessage(message: string | null | undefined): string | null {
  return isTransportConnectionErrorMessage(message) || isInterruptErrorMessage(message)
    ? null
    : (message ?? null);
}
