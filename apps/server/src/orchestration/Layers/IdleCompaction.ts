/**
 * IdleCompaction - compact idle Claude threads before the prompt cache expires (beta).
 *
 * Claude caches a conversation for an hour on subscriptions. A thread picked
 * back up after that re-sends its whole transcript uncached, which on a long
 * thread is the most expensive message the user sends all day. Shortly before
 * the cache lapses, this sends `/compact` as an ordinary, visible turn: the
 * compaction reads the transcript while it is still cheap, and the return reads
 * the short summary instead.
 *
 * One timer per thread, replaced by the next completed turn and cancelled by
 * any new message. Timers live in memory, so a restart drops the ones still
 * waiting — the worst case is the cost this feature exists to avoid, never a
 * surprise turn.
 *
 * @module IdleCompaction
 */
import {
  CommandId,
  type IdleCompactionMode,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  ProviderDriverKind,
  ThreadTokenUsageSnapshot,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import {
  IDLE_COMPACTION_ID_PREFIX,
  IDLE_COMPACTION_LEAD_MS,
  IDLE_COMPACTION_MIN_CONTEXT_TOKENS,
  IDLE_COMPACTION_REQUIRED_CACHE_TTL_MS,
  resolveIdleCompaction,
} from "@t3tools/shared/idleCompaction";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/**
 * Command id prefix of the turn this sends; the event log shows who started it.
 * Its message id carries the same prefix, which is how clients tell it apart.
 */
export const IDLE_COMPACTION_COMMAND_PREFIX = IDLE_COMPACTION_ID_PREFIX;

/** Command id prefix `TurnAutoResume` gives the turns it sends after a restart. */
const AUTO_RESUME_COMMAND_PREFIX = "auto-resume:";

export const IDLE_COMPACTION_PROMPT = "/compact";

/**
 * Deterministic per completed turn, so the engine's command receipts make a
 * second dispatch for the same turn a no-op whatever fires it.
 */
export const idleCompactionCommandId = (threadId: ThreadId, turnId: TurnId): CommandId =>
  CommandId.make(`${IDLE_COMPACTION_COMMAND_PREFIX}${threadId}:${turnId}`);

/** The user message that started a thread's latest turn, as the event log recorded it. */
export interface IdleCompactionUserTurn {
  readonly text: string;
  readonly commandId: string | null;
  /** The model the turn ran on, once its start request is seen. */
  readonly model?: string | undefined;
}

/** The latest context reading of a thread, with the turn that produced it. */
export interface IdleCompactionUsage {
  readonly turnId: string | null;
  readonly usage: ThreadTokenUsageSnapshot;
}

/**
 * A turn the app sent on the user's behalf. Compacting after one would answer
 * a compaction with a compaction, or keep a thread nobody is reading warm.
 */
export const isAutomaticTurn = (turn: IdleCompactionUserTurn): boolean =>
  turn.text.trim().toLowerCase().startsWith(IDLE_COMPACTION_PROMPT) ||
  (turn.commandId !== null &&
    (turn.commandId.startsWith(IDLE_COMPACTION_COMMAND_PREFIX) ||
      turn.commandId.startsWith(AUTO_RESUME_COMMAND_PREFIX)));

export type IdleCompactionDecision =
  | { readonly compact: true; readonly atMs: number }
  | {
      readonly compact: false;
      readonly reason:
        | "disabled"
        | "thread_unavailable"
        | "thread_done"
        | "not_claude"
        | "model_changed"
        | "turn_superseded"
        | "turn_not_completed"
        | "busy"
        | "awaiting_approval"
        | "awaiting_user_input"
        | "awaiting_plan_review"
        | "automatic_turn"
        | "no_usage"
        | "small_context"
        | "short_cache"
        | "cache_expired";
    };

/**
 * Whether a thread should be compacted for the turn the timer was set for,
 * and when. Pure so each guard can be tested on its own; run both when the turn
 * completes and again when the timer fires, against fresh state.
 */
export const decideIdleCompaction = (input: {
  /** The thread as the projection has it; null when deleted or unknown. */
  readonly thread: OrchestrationThreadShell | null;
  readonly turnId: TurnId;
  readonly mode: IdleCompactionMode;
  readonly userTurn: IdleCompactionUserTurn | undefined;
  readonly usage: IdleCompactionUsage | undefined;
  readonly nowMs: number;
}): IdleCompactionDecision => {
  const { thread, turnId, mode, userTurn, usage, nowMs } = input;
  if (mode !== "beforeCacheExpires") return { compact: false, reason: "disabled" };
  if (thread === null || thread.archivedAt !== null) {
    return { compact: false, reason: "thread_unavailable" };
  }
  // Settled by the user. A new message would also clear the mark.
  if (thread.doneAt !== null) return { compact: false, reason: "thread_done" };

  // The `/compact` goes wherever the thread points now, so that has to still
  // be the Claude instance holding the cache.
  const session = thread.session;
  if (session === null || session.providerName !== CLAUDE_DRIVER) {
    return { compact: false, reason: "not_claude" };
  }
  if (
    session.providerInstanceId !== undefined &&
    session.providerInstanceId !== thread.modelSelection.instanceId
  ) {
    return { compact: false, reason: "model_changed" };
  }
  // Another model has its own cache; compacting on it pays the full read.
  if (userTurn?.model !== undefined && userTurn.model !== thread.modelSelection.model) {
    return { compact: false, reason: "model_changed" };
  }

  const latestTurn = thread.latestTurn;
  if (latestTurn === null || latestTurn.turnId !== turnId) {
    return { compact: false, reason: "turn_superseded" };
  }
  if (latestTurn.state !== "completed") return { compact: false, reason: "turn_not_completed" };
  if (
    session.activeTurnId !== null ||
    session.status === "running" ||
    session.status === "starting"
  ) {
    return { compact: false, reason: "busy" };
  }
  if (thread.hasPendingApprovals) return { compact: false, reason: "awaiting_approval" };
  if (thread.hasPendingUserInput) return { compact: false, reason: "awaiting_user_input" };
  // Compacting would make the plan's turn no longer the latest, which retires
  // the plan the user has yet to review.
  if (thread.hasActionableProposedPlan) return { compact: false, reason: "awaiting_plan_review" };
  // Unknown counts as automatic: a turn this process never saw start is not
  // one it can vouch for.
  if (userTurn === undefined || isAutomaticTurn(userTurn)) {
    return { compact: false, reason: "automatic_turn" };
  }

  if (usage === undefined || usage.turnId !== turnId) return { compact: false, reason: "no_usage" };
  if (usage.usage.usedTokens < IDLE_COMPACTION_MIN_CONTEXT_TOKENS) {
    return { compact: false, reason: "small_context" };
  }
  // Five minutes would fire while the user is still reading; an unknown TTL
  // (a request read fully from cache, a proxy that hides the split) is no
  // basis for spending a turn.
  if (usage.usage.promptCacheTtlMs !== IDLE_COMPACTION_REQUIRED_CACHE_TTL_MS) {
    return { compact: false, reason: "short_cache" };
  }
  const expiresAtMs = Date.parse(usage.usage.promptCacheExpiresAt ?? "");
  if (!Number.isFinite(expiresAtMs)) return { compact: false, reason: "short_cache" };
  if (nowMs >= expiresAtMs) return { compact: false, reason: "cache_expired" };

  return { compact: true, atMs: Math.max(nowMs, expiresAtMs - IDLE_COMPACTION_LEAD_MS) };
};

const decodeUsage = Schema.decodeUnknownOption(ThreadTokenUsageSnapshot);

/** What the event stream has said about one thread since this process started. */
interface ThreadObservation {
  runningTurnId: TurnId | null;
  userTurn: IdleCompactionUserTurn | undefined;
  usage: IdleCompactionUsage | undefined;
}

export const makeIdleCompaction = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;

  const observations = new Map<ThreadId, ThreadObservation>();
  // Keyed by thread: running a newer timer interrupts the waiting one.
  const timers = yield* FiberMap.make<ThreadId>();

  const observe = (threadId: ThreadId): ThreadObservation => {
    const existing = observations.get(threadId);
    if (existing !== undefined) return existing;
    const created: ThreadObservation = {
      runningTurnId: null,
      userTurn: undefined,
      usage: undefined,
    };
    observations.set(threadId, created);
    return created;
  };

  const decide = Effect.fn("IdleCompaction.decide")(function* (threadId: ThreadId, turnId: TurnId) {
    const settings = yield* serverSettings.getSettings;
    const thread = Option.getOrNull(yield* projectionSnapshotQuery.getThreadShellById(threadId));
    const observation = observations.get(threadId);
    return decideIdleCompaction({
      thread,
      turnId,
      mode:
        thread === null
          ? settings.compactIdleThreads
          : resolveIdleCompaction(
              settings,
              thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
            ),
      userTurn: observation?.userTurn,
      usage: observation?.usage,
      nowMs: DateTime.toEpochMillis(yield* DateTime.now),
    });
  });

  const compact = Effect.fn("IdleCompaction.compact")(function* (
    thread: OrchestrationThreadShell,
    turnId: TurnId,
  ) {
    const commandId = idleCompactionCommandId(thread.id, turnId);
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId,
      threadId: thread.id,
      message: {
        // Same deterministic id, so the message itself says it was not typed.
        messageId: MessageId.make(commandId),
        role: "user",
        text: IDLE_COMPACTION_PROMPT,
        attachments: [],
      },
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
    yield* Effect.logInfo("idle-compaction.sent", { threadId: thread.id, turnId });
  });

  /** Waits for the window, re-checking everything, and compacts if it still should. */
  const compactWhenDue = Effect.fn("IdleCompaction.compactWhenDue")(
    function* (threadId: ThreadId, turnId: TurnId) {
      while (true) {
        const decision = yield* decide(threadId, turnId);
        if (!decision.compact) {
          yield* Effect.logDebug("idle-compaction.skipped", {
            threadId,
            turnId,
            reason: decision.reason,
          });
          return;
        }
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        if (nowMs < decision.atMs) {
          yield* Effect.sleep(Duration.millis(decision.atMs - nowMs));
          continue;
        }
        const thread = yield* projectionSnapshotQuery.getThreadShellById(threadId);
        if (Option.isNone(thread)) return;
        yield* compact(thread.value, turnId);
        return;
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("idle-compaction.failed", {
                threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
  );

  const cancel = (threadId: ThreadId) => FiberMap.remove(timers, threadId);

  const handleEvent = (event: OrchestrationEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "thread.message-sent": {
        if (event.payload.role !== "user") return Effect.void;
        observe(event.payload.threadId).userTurn = {
          // Only the opening matters (is it a `/compact`?); keeping the whole
          // message would hold every thread's last prompt in memory.
          text: event.payload.text.trimStart().slice(0, 64),
          commandId: event.commandId,
        };
        // A new message makes the waiting compaction moot — unless it is the
        // compaction itself, still being dispatched from inside that timer.
        return event.commandId?.startsWith(IDLE_COMPACTION_COMMAND_PREFIX)
          ? Effect.void
          : cancel(event.payload.threadId);
      }

      case "thread.turn-start-requested": {
        const observation = observe(event.payload.threadId);
        const model = event.payload.modelSelection?.model;
        if (observation.userTurn !== undefined && model !== undefined) {
          observation.userTurn = { ...observation.userTurn, model };
        }
        return Effect.void;
      }

      case "thread.activity-appended": {
        const { activity, threadId } = event.payload;
        if (activity.kind !== "context-window.updated") return Effect.void;
        const usage = decodeUsage(activity.payload);
        if (Option.isSome(usage)) {
          observe(threadId).usage = { turnId: activity.turnId, usage: usage.value };
        }
        return Effect.void;
      }

      case "thread.session-set": {
        const { session, threadId } = event.payload;
        const observation = observe(threadId);
        if (session.status === "running" && session.activeTurnId !== null) {
          observation.runningTurnId = session.activeTurnId;
          return cancel(threadId);
        }
        // The turn-end signal: the session settles with no active turn. Later
        // settles (the idle reaper stopping the session) find nothing running
        // and leave the timer alone — resuming a stopped session is the point.
        const turnId = observation.runningTurnId;
        if (turnId === null || session.activeTurnId !== null) return Effect.void;
        observation.runningTurnId = null;
        if (session.status !== "ready") return cancel(threadId);
        return decide(threadId, turnId).pipe(
          Effect.flatMap((decision) =>
            decision.compact
              ? FiberMap.run(timers, threadId, compactWhenDue(threadId, turnId)).pipe(Effect.asVoid)
              : cancel(threadId),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("idle-compaction.schedule-failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }

      case "thread.archived":
      case "thread.deleted":
        observations.delete(event.payload.threadId);
        return cancel(event.payload.threadId);

      default:
        return Effect.void;
    }
  };

  return {
    handleEvent,
    /** Whether a compaction is waiting for this thread. For tests and diagnostics. */
    isScheduled: (threadId: ThreadId) => FiberMap.has(timers, threadId),
  };
});

/** IdleCompactionLive - watch domain events for the life of the server. */
export const IdleCompactionLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const idleCompaction = yield* makeIdleCompaction;
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, idleCompaction.handleEvent),
    );
  }),
);
