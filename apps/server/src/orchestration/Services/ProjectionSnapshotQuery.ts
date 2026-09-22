/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  CheckpointRef,
  IsoDateTime,
  OrchestrationCheckpointSummary,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationMessage,
  OrchestrationThreadShell,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

/** A half-open page over a thread's messages, oldest first. */
export interface ThreadMessagePageOptions {
  /** Zero-based index of the first message to return. */
  readonly offset: number;
  readonly limit: number;
}

/**
 * One message reduced to what a map of the conversation needs: who spoke, when,
 * how much they wrote, and enough of the opening to recognise it.
 */
export interface OrchestrationMessageOutline {
  readonly id: MessageId;
  readonly role: OrchestrationMessage["role"];
  readonly turnId: OrchestrationMessage["turnId"];
  /** The opening of the text, cut in SQL. */
  readonly preview: string;
  /** Length of the whole text, not of the preview. */
  readonly charCount: number;
  readonly streaming: boolean;
  readonly createdAt: string;
}

/** One message containing a searched-for phrase, and where the phrase sits. */
export interface OrchestrationMessageMatch {
  readonly id: MessageId;
  readonly role: OrchestrationMessage["role"];
  readonly index: number;
  /** Zero-based offset of the first occurrence within the message text. */
  readonly matchOffset: number;
  readonly charCount: number;
  /** Text around the first occurrence. */
  readonly snippet: string;
  readonly createdAt: IsoDateTime;
}

export interface ProjectionFullThreadDiffContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly latestCheckpointTurnCount: number;
  readonly toCheckpointRef: CheckpointRef | null;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the lightweight command snapshot used to bootstrap the in-memory
   * orchestration engine without hydrating message/activity/checkpoint bodies.
   */
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only projects and thread shell summaries so clients can bootstrap
   * lightweight navigation state without hydrating every thread body.
   */
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read archived thread shell summaries for the archive page.
   *
   * This query is separate from the main shell snapshot so archived threads
   * are never bootstrapped into normal navigation state.
   */
  readonly getArchivedShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest projection snapshot sequence without hydrating read-model
   * entities.
   */
  readonly getSnapshotSequence: () => Effect.Effect<
    ProjectionSnapshotSequence,
    ProjectionRepositoryError
  >;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /**
   * Read only the narrow context needed to compute a full-thread diff from
   * checkpoint 0 to a specific turn count.
   */
  readonly getFullThreadDiffContext: (
    threadId: ThreadId,
    toTurnCount: number,
  ) => Effect.Effect<Option.Option<ProjectionFullThreadDiffContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread shell row by id.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id.
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read the most recent `limit` messages of one thread, oldest first.
   *
   * `getThreadDetailById` returns every message a conversation ever had, which
   * a caller showing only the tail then throws away. Long conversations make
   * that the dominant cost of reading one.
   */
  readonly getThreadMessagesTail: (
    threadId: ThreadId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<OrchestrationMessage>, ProjectionRepositoryError>;

  /**
   * One line per message, oldest first: role, timestamp, how long the text
   * really is, and its opening characters.
   *
   * This is how a caller reads a conversation's shape without reading the
   * conversation. Preview and length are computed in SQL, so mapping a
   * five-hundred-message thread costs kilobytes rather than the megabytes its
   * text weighs — which is what makes "decide what is worth reading" affordable
   * at all.
   */
  readonly listThreadMessageOutline: (
    threadId: ThreadId,
    options: ThreadMessagePageOptions & { readonly previewChars: number },
  ) => Effect.Effect<ReadonlyArray<OrchestrationMessageOutline>, ProjectionRepositoryError>;

  /**
   * A window of messages anywhere in the thread, oldest first.
   *
   * The tail query can only ever hand back the end. This is the one that reads
   * the middle: where something was decided, or argued out, or where the work
   * actually happened.
   */
  readonly listThreadMessageWindow: (
    threadId: ThreadId,
    options: ThreadMessagePageOptions,
  ) => Effect.Effect<ReadonlyArray<OrchestrationMessage>, ProjectionRepositoryError>;

  /**
   * How many messages the thread has, so a page can say what it is a page of
   * and a caller can tell "that is all of it" from "that is where I stopped".
   */
  readonly countThreadMessages: (
    threadId: ThreadId,
  ) => Effect.Effect<number, ProjectionRepositoryError>;

  /**
   * Zero-based position of one message within its thread, or none when the id
   * is not in it. Turns a search hit into a place to read around.
   */
  readonly getThreadMessagePosition: (
    threadId: ThreadId,
    messageId: MessageId,
  ) => Effect.Effect<Option.Option<number>, ProjectionRepositoryError>;

  /**
   * Every message in one thread containing a literal phrase, oldest first, with
   * where in the thread and where in the message each hit falls.
   *
   * The cross-conversation index answers "which conversation is this in"; it
   * cannot answer "where in this conversation", which is what a caller holding
   * one long thread actually needs. Matched in SQL so a phrase can be found in
   * a conversation without reading it.
   */
  readonly searchThreadMessages: (
    threadId: ThreadId,
    options: { readonly query: string; readonly limit: number; readonly snippetChars: number },
  ) => Effect.Effect<ReadonlyArray<OrchestrationMessageMatch>, ProjectionRepositoryError>;

  /**
   * The turn a message belongs to, or none when the message is not in the
   * thread. Cheap on purpose: resolving "which turn produced this" must not
   * mean loading the message, which can be a hundred kilobytes of text.
   */
  readonly getThreadMessageTurn: (
    threadId: ThreadId,
    messageId: MessageId,
  ) => Effect.Effect<Option.Option<string>, ProjectionRepositoryError>;

  /**
   * The tool calls of one turn, in the order they ran, with their payloads.
   *
   * This is the only record of what a conversation actually did rather than
   * what it said it did — the commands, the files, the output they printed.
   * Narrow by turn and by kind in SQL: these rows carry the largest payloads a
   * thread stores, so reading a whole thread's worth to show one turn would
   * cost megabytes.
   */
  readonly listThreadTurnToolActivities: (
    threadId: ThreadId,
    turnId: string,
    options: ThreadMessagePageOptions,
  ) => Effect.Effect<ReadonlyArray<OrchestrationThreadActivity>, ProjectionRepositoryError>;

  /** How many tool calls that turn ran, so a page of them can say what it is a page of. */
  readonly countThreadTurnToolActivities: (
    threadId: ThreadId,
    turnId: string,
  ) => Effect.Effect<number, ProjectionRepositoryError>;

  /** How many messages contain the phrase, so a page of hits can say what it is a page of. */
  readonly countThreadMessageMatches: (
    threadId: ThreadId,
    query: string,
  ) => Effect.Effect<number, ProjectionRepositoryError>;

  /**
   * Completed tool calls per turn, keyed by turn id.
   *
   * Counted in SQL rather than derived from the activity rows: the payloads
   * behind these are the largest thing a thread stores, and the outline only
   * needs to say whether a turn did work, not what the work was.
   */
  readonly countThreadToolCallsByTurn: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyMap<string, number>, ProjectionRepositoryError>;

  /**
   * Read only the activities of the given kinds for one thread.
   *
   * `getThreadDetailById` loads a thread's whole activity log, which is sized
   * for rendering a timeline — every tool call, every step, with payloads. A
   * caller that derives state from two or three kinds pays megabytes to read
   * kilobytes: across this projection the orchestrator's kinds are 0.1% of the
   * stored payload bytes. Same rows, same order, filtered in SQL.
   */
  readonly listThreadActivitiesByKinds: (
    threadId: ThreadId,
    kinds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<OrchestrationThreadActivity>, ProjectionRepositoryError>;

  /**
   * The completed `suggest_followup` tool calls in one thread — a handful of
   * rows even on a long conversation.
   *
   * Follow-ups recorded before the adapter learned to read misnamed arguments
   * hold no detail of their own, but the call that made them still carries the
   * text the agent wrote. This is the repair read: narrow enough in SQL that it
   * costs nothing next to loading every tool call to find three.
   */
  readonly listFollowupToolCallActivities: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationThreadActivity>, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
