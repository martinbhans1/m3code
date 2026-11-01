import { useCallback, useMemo, useState } from "react";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  buildFollowupPrompt,
  buildFollowupThreadTitle,
  derivePendingFollowups,
  type FollowupState,
} from "@t3tools/shared/followups";
import { truncate } from "@t3tools/shared/String";

import { makeTurnCommandMetadata } from "../lib/commandMetadata";
import type { FollowupProjectChoice } from "../lib/followupMenu";
import { uuidv4 } from "../lib/uuid";
import { getEnvironmentClient } from "./environment-session-registry";
import { useRemoteCatalog } from "./use-remote-catalog";
import { useSelectedThreadDetail } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";

const NO_PROJECT_CHOICES: ReadonlyArray<FollowupProjectChoice> = [];

export function useSelectedThreadFollowups() {
  const { selectedThread: selectedThreadShell, selectedThreadProject } = useThreadSelection();
  const selectedThread = useSelectedThreadDetail();
  const { projects, serverConfigByEnvironmentId } = useRemoteCatalog();
  const [busyId, setBusyId] = useState<string | null>(null);

  const environmentId = selectedThreadShell?.environmentId ?? null;
  const orchestratorProjectId = environmentId
    ? (serverConfigByEnvironmentId[environmentId]?.settings.orchestratorProjectId ?? null)
    : null;

  const followups = useMemo(
    () => (selectedThread ? derivePendingFollowups(selectedThread.activities) : []),
    [selectedThread],
  );

  const projectChoices = useMemo(
    () =>
      orchestratorProjectId === null || selectedThreadProject?.id !== orchestratorProjectId
        ? NO_PROJECT_CHOICES
        : projects
            .filter(
              (project) =>
                project.environmentId === environmentId && project.id !== orchestratorProjectId,
            )
            .map((project) => ({ id: project.id, title: project.title }))
            .toSorted((left, right) => left.title.localeCompare(right.title)),
    [environmentId, orchestratorProjectId, projects, selectedThreadProject?.id],
  );

  const threadBusy =
    selectedThread?.session?.status === "running" || selectedThread?.session?.status === "starting";

  const writeStatus = useCallback(
    async (
      followup: FollowupState,
      patch: { status: FollowupState["status"]; implementationThreadId?: ThreadId },
    ) => {
      const client = environmentId ? getEnvironmentClient(environmentId) : null;
      if (!client || !selectedThread) {
        throw new Error("Not connected to your computer.");
      }
      const now = new Date().toISOString();
      await client.orchestration.dispatchCommand({
        type: "thread.followup.upsert",
        commandId: CommandId.make(uuidv4()),
        threadId: selectedThread.id,
        followup: {
          id: followup.id,
          turnId: followup.turnId,
          title: followup.title,
          detail: followup.detail,
          rationale: followup.rationale,
          status: patch.status,
          implementationThreadId: patch.implementationThreadId ?? null,
          createdAt: followup.createdAt,
          updatedAt: now,
        },
        createdAt: now,
      });
    },
    [environmentId, selectedThread],
  );

  const withBusy = useCallback(async (followup: FollowupState, work: () => Promise<void>) => {
    setBusyId(followup.id);
    try {
      await work();
    } finally {
      setBusyId((current) => (current === followup.id ? null : current));
    }
  }, []);

  const onDismiss = useCallback(
    (followup: FollowupState) =>
      withBusy(followup, () => writeStatus(followup, { status: "dismissed" })),
    [withBusy, writeStatus],
  );

  // Starts a separate conversation and stays put: a follow-up is spun off so it
  // does not interrupt this one. Thread and first message go in one command, so
  // a failure cannot leave an empty conversation behind.
  const onStartInNewConversation = useCallback(
    (followup: FollowupState, projectId: ProjectId | null) =>
      withBusy(followup, async () => {
        const client = environmentId ? getEnvironmentClient(environmentId) : null;
        if (!client || !selectedThread) {
          throw new Error("Not connected to your computer.");
        }
        const targetProjectId = projectId ?? selectedThread.projectId;
        // A different project is a different repository, so this thread's
        // branch and checkout mean nothing there.
        const crossProject = targetProjectId !== selectedThread.projectId;
        const metadata = makeTurnCommandMetadata();
        const threadId = ThreadId.make(metadata.threadId);
        const title = truncate(buildFollowupThreadTitle(followup));
        const { modelSelection, runtimeMode } = selectedThread;
        await client.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: CommandId.make(metadata.commandId),
          threadId,
          message: {
            messageId: MessageId.make(metadata.messageId),
            role: "user",
            text: buildFollowupPrompt(followup),
            attachments: [],
          },
          modelSelection,
          titleSeed: title,
          runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          bootstrap: {
            createThread: {
              projectId: targetProjectId,
              title,
              modelSelection,
              runtimeMode,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              branch: crossProject ? null : selectedThread.branch,
              worktreePath: crossProject ? null : selectedThread.worktreePath,
              createdAt: metadata.createdAt,
            },
          },
          createdAt: metadata.createdAt,
        });
        await writeStatus(followup, { status: "spunOff", implementationThreadId: threadId });
      }),
    [environmentId, selectedThread, withBusy, writeStatus],
  );

  const onDoInThisConversation = useCallback(
    (followup: FollowupState) =>
      withBusy(followup, async () => {
        const client = environmentId ? getEnvironmentClient(environmentId) : null;
        if (!client || !selectedThread) {
          throw new Error("Not connected to your computer.");
        }
        const metadata = makeTurnCommandMetadata();
        await client.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: CommandId.make(metadata.commandId),
          threadId: selectedThread.id,
          message: {
            messageId: MessageId.make(metadata.messageId),
            role: "user",
            text: buildFollowupPrompt(followup),
            attachments: [],
          },
          modelSelection: selectedThread.modelSelection,
          titleSeed: selectedThread.title,
          runtimeMode: selectedThread.runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: metadata.createdAt,
        });
        await writeStatus(followup, { status: "done" });
      }),
    [environmentId, selectedThread, withBusy, writeStatus],
  );

  return {
    followups,
    busyId,
    threadBusy,
    projectChoices,
    onDismiss,
    onStartInNewConversation,
    onDoInThisConversation,
  };
}
