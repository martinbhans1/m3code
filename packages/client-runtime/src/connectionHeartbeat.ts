/**
 * Configuration for the RPC socket heartbeat.
 *
 * The Effect RPC socket protocol writes a `Ping` on a fixed interval and fails
 * the socket when the peer does not answer. Its stock behaviour is a 5s
 * interval with zero tolerance: one round trip that misses the window tears
 * down an otherwise healthy connection. That is fine on loopback and hostile
 * anywhere else — a phone on cellular, a relayed connection, or a server busy
 * streaming a turn all routinely blow a 5s budget without actually being gone.
 */
export interface ConnectionHeartbeatConfig {
  /** Delay between pings, in milliseconds. */
  readonly intervalMillis: number;
  /**
   * Consecutive unanswered pings tolerated before the socket is declared dead.
   * Any inbound `Pong` resets the counter, so this only accumulates while the
   * link is genuinely silent.
   */
  readonly maxMissedPongs: number;
}

/**
 * Defaults tuned for real networks rather than loopback.
 *
 * 10s between pings with 3 missed pongs tolerated means a silently dead socket
 * is detected within ~30s, while a transient stall of up to ~20s rides through
 * untouched. Sockets that close cleanly are still noticed immediately — the
 * browser reports the close event and the heartbeat never enters the picture.
 */
export const DEFAULT_CONNECTION_HEARTBEAT: ConnectionHeartbeatConfig = {
  intervalMillis: 10_000,
  maxMissedPongs: 3,
};

/**
 * Worst-case time before a silently dead socket is reported, used by the UI to
 * decide how long a gap has to last before it is worth telling the user about.
 */
export function getHeartbeatDetectionWindowMs(
  config: ConnectionHeartbeatConfig = DEFAULT_CONNECTION_HEARTBEAT,
): number {
  return config.intervalMillis * (config.maxMissedPongs + 1);
}
