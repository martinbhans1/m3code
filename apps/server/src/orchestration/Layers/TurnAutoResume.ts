/**
 * TurnAutoResume - Restart-resilient turns.
 *
 * Provider sessions run inside this process, so every turn that is mid-flight
 * when the app quits (an update, a reinstall, a crash) dies with it. Nothing
 * about that is recoverable from the user's side except noticing it, opening
 * the thread, and typing "continue" — and a half-finished turn that nobody
 * notices is worse than one that visibly failed.
 *
 * The conversation itself survives: messages are in the projection and the
 * provider keeps a resume cursor in `provider_session_runtime`, so sending a
 * fresh turn resumes the same underlying agent session with its full context.
 * This layer does exactly that, automatically, for the threads that were
 * actually working when the process went away.
 *
 * There are two ways in: shutdown captures the mid-turn threads, and boot
 * re-scans the projection for turns that never settled. The second is the one
 * that carries the weight on Windows, where the desktop shell can only stop
 * the backend forcefully — `subprocess.kill("SIGTERM")` maps to
 * `TerminateProcess`, no finalizer runs, and the projection is simply left
 * holding a running turn. The capture is what covers the graceful stops
 * (Ctrl-C on `t3 serve`, a signal on macOS/Linux), where the turn may already
 * have been settled by the time the next boot looks.
 *
 * @module TurnAutoResume
 */
import {
  CommandId,
  MessageId,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { sessionOwnerLiveness, type SessionOwnerLiveness } from "../../provider/sessionOwner.ts";
import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  emptyTurnAutoResumeState,
  readTurnAutoResumeState,
  writeTurnAutoResumeState,
  type TurnAutoResumeHistoryEntry,
  type TurnAutoResumeInFlightEntry,
} from "../turnAutoResumeState.ts";

/**
 * A thread that keeps dying mid-turn must not collect an endless stack of
 * "continue" messages. Three consecutive auto-resumes with no word from the
 * user in between is the ceiling; after that the thread is left alone and
 * shows up as interrupted, which is the honest signal.
 */
const MAX_CONSECUTIVE_AUTO_RESUMES = 3;

/** Shutdown budget for the capture; see the finalizer for why it is this tight. */
const CAPTURE_TIMEOUT = Duration.millis(1_200);

/**
 * Hard ceiling on how old the evidence may be, independent of any boot marker.
 * Interrupted work is worth picking up the same day; a turn row left open a
 * week ago is archaeology, and re-entering it costs a full context load to be
 * told the work was already done.
 */
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The turn text sent on the user's behalf. It is a real, visible user message
 * — the transcript should show exactly why the agent started talking again —
 * and it tells the agent to re-check state rather than assume its pre-restart
 * working memory still holds.
 */
const AUTO_RESUME_PROMPT = [
  "[Automatic resume after app restart]",
  "",
  "The app restarted while you were working, so your previous turn was cut off",
  "mid-flight. Nothing you had not already written to disk survived.",
  "",
  "Re-establish where things actually stand before continuing: check the files you",
  "were editing, your task list, and anything you had started but may not have",
  "finished. Then carry on from there. Do not redo work that is already complete,",
  "and if the previous turn had clearly finished everything that was asked, just",
  "say so briefly instead of inventing more work.",
].join("\n");

/**
 * Whether the projection still shows an unfinished turn.
 *
 * This is a necessary condition, never a sufficient one. Turn rows are sticky:
 * if a process dies between the agent's last message and the event that settles
 * the turn, the row stays `running` in the database forever. Real threads have
 * been observed sitting at `running` for months after the work finished, so
 * treating this as "the agent was working" resurrects long-dead conversations.
 */
export const hasUnsettledTurn = (thread: OrchestrationThreadShell): boolean =>
  thread.latestTurn !== null && thread.latestTurn.state === "running";

/**
 * What the provider's own session record says about a thread.
 *
 * `activeTurnId` is written when a turn starts — and, contrary to what its name
 * suggests, is *not* cleared when the turn ends. A thread whose last turn
 * completed hours ago still names that turn here. It is therefore only useful
 * as a pairing check: the id it names must be the thread's latest turn, and
 * that turn must still be unsettled. When a turn ends normally the projection
 * settles it, the pair stops matching, and the thread drops out.
 */
export interface ProviderTurnEvidence {
  readonly activeTurnId: string | null;
  /** Provider's last write for this thread, used to bound how old the evidence may be. */
  readonly lastSeenAt: string | null;
  /**
   * Whether the backend process that wrote this session record is still
   * running. Omitted means unknown — the state of every row written before
   * sessions carried an owner.
   */
  readonly ownerLiveness?: SessionOwnerLiveness;
}

/**
 * Decide whether a thread should be resumed on this boot, and why not when it
 * should not. Pure so the rules can be tested without standing up a runtime.
 */
export type AutoResumeDecision =
  | { readonly resume: true; readonly consecutiveAutoResumes: number }
  | {
      readonly resume: false;
      readonly reason:
        | "turn_settled"
        | "session_owned_by_live_backend"
        | "provider_turn_mismatch"
        | "stale_evidence"
        | "awaiting_approval"
        | "awaiting_user_input"
        | "resume_limit_reached";
    };

export const decideAutoResume = (input: {
  readonly thread: OrchestrationThreadShell;
  readonly wasCapturedInFlight: boolean;
  readonly evidence: ProviderTurnEvidence;
  readonly history: TurnAutoResumeHistoryEntry | undefined;
  /**
   * When the previous process started, if known. Work cut off by this restart
   * necessarily happened after it.
   */
  readonly previousBootAt: string | null;
  readonly now: string;
}): AutoResumeDecision => {
  const { thread, wasCapturedInFlight, evidence, history, previousBootAt, now } = input;

  // Nothing to continue unless the projection still has the turn open. This
  // rejects turns that ended in any way at all, including the ones that ended
  // badly: a turn that failed (an expired login, a provider error) is settled
  // and answered, and resuming it just burns tokens re-reading a dead end.
  if (!hasUnsettledTurn(thread)) {
    return { resume: false, reason: "turn_settled" };
  }

  // An open turn whose session is held by a process that is still running was
  // never orphaned — it is streaming right now, in the app next door or in this
  // very process. Resuming it starts a second provider session against a
  // conversation the first one has open, which Codex refuses outright (one
  // writer per conversation) and surfaces as an error on healthy work.
  //
  // Checked ahead of everything else, including the shutdown capture: whatever
  // that capture recorded, it was recorded about a process that has since
  // exited, so it can never be evidence about a live one.
  const ownerLiveness = evidence.ownerLiveness ?? "unknown";
  if (ownerLiveness === "live" || ownerLiveness === "self") {
    return { resume: false, reason: "session_owned_by_live_backend" };
  }

  // The provider has to have been working on *that* turn. Its `activeTurnId` is
  // never cleared, so on its own it means nothing — but when it names a turn
  // other than the open one, the open turn is a leftover row and not live work.
  const providerWasOnThisTurn = evidence.activeTurnId === thread.latestTurn?.turnId;
  if (!wasCapturedInFlight && !providerWasOnThisTurn) {
    return { resume: false, reason: "provider_turn_mismatch" };
  }

  // Both signals above are sticky — a turn row orphaned by a crash months ago
  // still looks exactly like one orphaned by the restart a minute ago. Time is
  // the only thing that separates them, so the evidence must fall inside the
  // window the dead process was alive, and within a day regardless.
  const lastActivityAt =
    evidence.lastSeenAt !== null && evidence.lastSeenAt > thread.updatedAt
      ? evidence.lastSeenAt
      : thread.updatedAt;
  const oldestAcceptable = DateTime.formatIso(
    DateTime.subtract(DateTime.makeUnsafe(now), { milliseconds: MAX_EVIDENCE_AGE_MS }),
  );
  const freshnessFloor =
    previousBootAt !== null && previousBootAt > oldestAcceptable
      ? previousBootAt
      : oldestAcceptable;
  if (lastActivityAt < freshnessFloor) {
    return { resume: false, reason: "stale_evidence" };
  }

  // A thread parked on an approval or a question is already visible as blocked,
  // and the pending request's callback died with the old process. Sending a
  // turn would not unblock it, so leave it for the user.
  if (thread.hasPendingApprovals) {
    return { resume: false, reason: "awaiting_approval" };
  }
  if (thread.hasPendingUserInput) {
    return { resume: false, reason: "awaiting_user_input" };
  }

  // The stored timestamp is the exact `createdAt` of the message we injected.
  // If it is still the thread's newest user message, the user has not spoken
  // since and this would be another consecutive auto-resume.
  const consecutiveAutoResumes =
    history !== undefined && history.lastAutoResumeAt === thread.latestUserMessageAt
      ? history.consecutiveAutoResumes
      : 0;

  if (consecutiveAutoResumes >= MAX_CONSECUTIVE_AUTO_RESUMES) {
    return { resume: false, reason: "resume_limit_reached" };
  }

  return { resume: true, consecutiveAutoResumes };
};

const activeTurnIdFromRuntimePayload = (payload: unknown): string | null => {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const activeTurnId = (payload as Record<string, unknown>).activeTurnId;
  return typeof activeTurnId === "string" && activeTurnId.length > 0 ? activeTurnId : null;
};

export const makeTurnAutoResume = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const startup = yield* ServerRuntimeStartup;
  const directory = yield* ProviderSessionDirectory;
  const crypto = yield* Crypto.Crypto;

  const statePath = config.turnAutoResumeStatePath;

  /**
   * Record which threads were mid-turn, so the next boot can tell a turn the
   * app killed from a turn the user stopped on purpose.
   *
   * Runs as a shutdown finalizer, and deliberately before `ProviderService`
   * tears its sessions down — once `stopAll` has run, every binding reads as
   * stopped with no active turn and the evidence is gone.
   */
  const captureInFlightTurns = Effect.gen(function* () {
    const previous = yield* readTurnAutoResumeState(statePath).pipe(
      Effect.orElseSucceed(() => emptyTurnAutoResumeState),
    );
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const capturedAt = DateTime.formatIso(yield* DateTime.now);

    // Only sessions actually holding a turn. The projection's own turn state is
    // no help here: it stays `running` long after the work ended, so using it
    // would capture threads that finished months ago.
    const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread] as const));
    const inFlight = new Map<ThreadId, TurnAutoResumeInFlightEntry>();
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    for (const binding of bindings) {
      if (binding.status === "stopped" || !threadsById.has(binding.threadId)) {
        continue;
      }
      const activeTurnId = activeTurnIdFromRuntimePayload(binding.runtimePayload);
      if (activeTurnId === null) {
        continue;
      }
      inFlight.set(binding.threadId, {
        threadId: binding.threadId,
        turnId: activeTurnId,
        capturedAt,
      });
    }

    yield* writeTurnAutoResumeState({
      path: statePath,
      state: {
        version: 1,
        ...(previous.bootedAt !== undefined ? { bootedAt: previous.bootedAt } : {}),
        inFlight: [...inFlight.values()],
        history: previous.history,
      },
    });

    if (inFlight.size > 0) {
      yield* Effect.logInfo("turn.auto-resume.captured", {
        threadCount: inFlight.size,
        threadIds: [...inFlight.keys()],
      });
    }
  });

  const resumeThread = Effect.fn("TurnAutoResume.resumeThread")(function* (
    thread: OrchestrationThreadShell,
  ) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const commandUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const messageUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);

    yield* startup.enqueueCommand(
      orchestrationEngine.dispatch({
        type: "thread.turn.start",
        // Prefixed so the event log shows at a glance that this turn was
        // machine-issued after a restart rather than typed by the user.
        commandId: CommandId.make(`auto-resume:${commandUuid}`),
        threadId: thread.id,
        message: {
          messageId: MessageId.make(messageUuid),
          role: "user",
          text: AUTO_RESUME_PROMPT,
          attachments: [],
        },
        // Inherit the thread's own configuration — worktree, branch, model and
        // permissions already fit the work that was interrupted.
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt,
      }),
    );

    return createdAt;
  });

  /**
   * Resume everything that was cut off, then rewrite the state file so the
   * consecutive-resume counters survive into the next restart.
   */
  const resumeInterruptedTurns = Effect.gen(function* () {
    const persisted = yield* readTurnAutoResumeState(statePath).pipe(
      Effect.orElseSucceed(() => emptyTurnAutoResumeState),
    );
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();

    const capturedThreadIds = new Set(persisted.inFlight.map((entry) => entry.threadId));
    const historyByThreadId = new Map(
      persisted.history.map((entry) => [entry.threadId, entry] as const),
    );

    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    const evidenceByThreadId = new Map(
      bindings.map(
        (binding) =>
          [
            binding.threadId,
            {
              activeTurnId:
                binding.status === "stopped"
                  ? null
                  : activeTurnIdFromRuntimePayload(binding.runtimePayload),
              lastSeenAt: binding.lastSeenAt,
              ownerLiveness: sessionOwnerLiveness(binding.runtimePayload),
            } satisfies ProviderTurnEvidence,
          ] as const,
      ),
    );

    const bootedAt = DateTime.formatIso(yield* DateTime.now);
    const previousBootAt = persisted.bootedAt ?? null;
    const nextHistory: Array<TurnAutoResumeHistoryEntry> = [];
    let resumedCount = 0;

    for (const thread of snapshot.threads) {
      const decision = decideAutoResume({
        thread,
        wasCapturedInFlight: capturedThreadIds.has(thread.id),
        evidence: evidenceByThreadId.get(thread.id) ?? {
          activeTurnId: null,
          lastSeenAt: null,
        },
        history: historyByThreadId.get(thread.id),
        previousBootAt,
        now: bootedAt,
      });

      if (!decision.resume) {
        // `turn_settled` is the overwhelmingly common answer — every finished
        // thread in the workspace lands there — so it is not worth a log line.
        if (decision.reason !== "turn_settled") {
          yield* Effect.logInfo("turn.auto-resume.skipped", {
            threadId: thread.id,
            reason: decision.reason,
          });
        }
        continue;
      }

      const consecutive = decision.consecutiveAutoResumes;
      const outcome = yield* resumeThread(thread).pipe(
        Effect.map((createdAt) => ({ ok: true as const, createdAt })),
        Effect.catchCause((cause) =>
          Effect.logWarning("turn.auto-resume.failed", {
            threadId: thread.id,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ ok: false as const })),
        ),
      );

      if (!outcome.ok) {
        continue;
      }

      resumedCount += 1;
      nextHistory.push({
        threadId: thread.id,
        consecutiveAutoResumes: consecutive + 1,
        lastAutoResumeAt: outcome.createdAt,
      });
      yield* Effect.logInfo("turn.auto-resume.resumed", {
        threadId: thread.id,
        title: thread.title,
        consecutiveAutoResumes: consecutive + 1,
      });
    }

    // Only threads resumed on this boot keep history; anything else has either
    // settled or been abandoned, and stale counters would only ever cause a
    // future resume to be skipped for the wrong reason.
    yield* writeTurnAutoResumeState({
      path: statePath,
      state: { version: 1, bootedAt, inFlight: [], history: nextHistory },
    });

    if (resumedCount > 0) {
      yield* Effect.logInfo("turn.auto-resume.complete", { resumedCount });
    }
  });

  return { captureInFlightTurns, resumeInterruptedTurns };
});

const logFailure = (event: string) => (cause: Cause.Cause<unknown>) =>
  Effect.logWarning(event, { cause: Cause.pretty(cause) });

/**
 * TurnAutoResumeLive - Wire auto-resume into the server lifecycle.
 *
 * Must be built at the outermost runtime level: layers are finalized in
 * reverse build order, and the shutdown capture has to run before
 * `ProviderService` stops the sessions it is reading.
 */
export const TurnAutoResumeLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const autoResume = yield* makeTurnAutoResume;

    yield* Effect.addFinalizer(() =>
      autoResume.captureInFlightTurns.pipe(
        // The desktop shell gives the backend two seconds between SIGTERM and a
        // hard kill, and the session teardown still has to fit in there. If the
        // capture cannot finish well inside that, boot-time detection of
        // unfinished turns covers the same ground anyway.
        Effect.timeout(CAPTURE_TIMEOUT),
        Effect.catchCause(logFailure("turn.auto-resume.capture-failed")),
      ),
    );

    // Forked: `enqueueCommand` parks until the orchestration engine has
    // replayed its event log, which happens after this layer is built.
    yield* Effect.forkScoped(
      autoResume.resumeInterruptedTurns.pipe(
        Effect.catchCause(logFailure("turn.auto-resume.boot-failed")),
      ),
    );
  }),
);
