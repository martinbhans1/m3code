/**
 * sessionOwner - Which backend process a provider session belongs to.
 *
 * `provider_session_runtime` is shared state: a dev backend started from the
 * repo defaults to the same data directory as the installed app, and the CLI
 * opens it too. A row there says a session is running, but says nothing about
 * *whose* process is running it — and a reader that assumes "mine" will act on
 * a live session belonging to somebody else.
 *
 * The concrete damage is restart recovery. A second backend boots, sees the
 * first one's in-flight turns as work its own crash orphaned, and resumes
 * them; the resumed session then asks the provider to reopen a conversation
 * the first backend is still writing to. Codex refuses that outright — it
 * takes an exclusive per-conversation writer lock — and the user gets an error
 * banner on a conversation that was answering perfectly well.
 *
 * So every write stamps the writer's pid into the runtime payload, and a
 * reader that is about to act on somebody's session can ask whether that
 * process is still alive.
 *
 * @module sessionOwner
 */
import { hasLiveSiblingBackend } from "../backendPeers.ts";
import { isProcessAlive } from "../serverRuntimeState.ts";

/** Payload key holding the pid of the backend that last wrote the row. */
export const SESSION_OWNER_PID_KEY = "ownerPid";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Add this process's pid to a runtime payload on its way to the database.
 *
 * Applied to every write, including the ones that pass no payload of their own:
 * an unstamped row is indistinguishable from one written by a backend that
 * predates this stamp, and both have to be treated as "owner unknown".
 */
export function stampSessionOwner(payload: unknown | null | undefined): Record<string, unknown> {
  return {
    ...(isRecord(payload) ? payload : {}),
    [SESSION_OWNER_PID_KEY]: process.pid,
  };
}

/**
 * The pid stamped on a persisted session, or null when the row predates the
 * stamp. Null means unknown, never "mine".
 */
export function readSessionOwnerPid(payload: unknown): number | null {
  if (!isRecord(payload)) {
    return null;
  }
  const value = payload[SESSION_OWNER_PID_KEY];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * - `self` — this process wrote the row, so the session lives here.
 * - `live` — another backend wrote it and that process is still running.
 * - `gone` — the backend that wrote it has exited; its sessions died with it.
 * - `unknown` — no pid stamped, which is every row written before the stamp
 *   existed. Never treated as somebody else's, or carrying a conversation over
 *   from an older build would quietly disable restart recovery for it.
 */
export type SessionOwnerLiveness = "self" | "live" | "gone" | "unknown";

export function sessionOwnerLiveness(
  payload: unknown,
  options?: { readonly isProcessAlive?: (pid: number) => boolean },
): SessionOwnerLiveness {
  const ownerPid = readSessionOwnerPid(payload);
  if (ownerPid === null) {
    return "unknown";
  }
  if (ownerPid === process.pid) {
    return "self";
  }
  const alive = options?.isProcessAlive ?? isProcessAlive;
  return alive(ownerPid) ? "live" : "gone";
}

/**
 * Whether this session belongs to a backend other than ours that is still
 * running — the case where touching it reaches across a process boundary into
 * work this process has no business interfering with.
 *
 * Pids are recycled, so an unrelated process inheriting a dead backend's pid
 * reads as live here. That direction is the safe one: the caller declines to
 * touch a session that was in fact already dead, which costs an automatic
 * resume the user can trigger by hand. The opposite mistake breaks a
 * conversation that is working.
 */
export function isOwnedByLiveForeignBackend(
  payload: unknown,
  options?: { readonly isProcessAlive?: (pid: number) => boolean },
): boolean {
  return sessionOwnerLiveness(payload, options) === "live";
}

/**
 * Whether a background job should keep its hands off this session.
 *
 * True for a session running in another live process, and - only while another
 * backend is sharing this data directory - for a session with no owner
 * recorded at all. An unowned row is either ours from before the last restart
 * or the neighbour's from a build that predates the stamp, and while both are
 * possible the safe reading is the neighbour's: the cost of being wrong is a
 * skipped cleanup, against breaking a conversation somebody is watching.
 */
export function isSessionOffLimits(
  payload: unknown,
  options?: {
    readonly isProcessAlive?: (pid: number) => boolean;
    readonly hasLiveSiblingBackend?: () => boolean;
  },
): boolean {
  const liveness = sessionOwnerLiveness(payload, options);
  if (liveness === "live") {
    return true;
  }
  if (liveness === "unknown") {
    return (options?.hasLiveSiblingBackend ?? hasLiveSiblingBackend)();
  }
  return false;
}
