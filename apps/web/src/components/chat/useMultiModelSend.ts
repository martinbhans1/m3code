import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import type { ComposerImageAttachment, DraftId } from "../../composerDraftStore";
import { readEnvironmentApi } from "../../environmentApi";
import { newCommandId, newMessageId, newThreadId, randomHex } from "~/lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { readFileAsDataUrl } from "../ChatView.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  formatOutgoingPrompt,
  getComposerProviderState,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
} from "./composerProviderState";
import { useMultiModelSelectionStore } from "./multiModelSelectionStore";
import {
  type MultiModelTarget,
  resolveMultiModelTargets,
  resolveSelectionsToRestore,
  startMultiModelThreads,
} from "./multiModelSend";

export interface MultiModelSendInput {
  readonly environmentId: EnvironmentId;
  readonly draftId: DraftId;
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  readonly baseBranch: string;
  readonly selections: ReadonlyArray<ModelSelection>;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  /** The prompt with terminal, element, preview and review context appended. */
  readonly messageText: string;
  readonly titleSeed: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly setError: (error: string | null) => void;
  readonly clearComposer: () => void;
  /** Puts the sent prompt back unless the user has typed something new. */
  readonly restoreComposer: () => void;
  /** Collapses the picker to one model when a single pick is left to retry. */
  readonly selectSingleModel: (instanceId: ProviderInstanceId, model: string) => void;
}

/**
 * Starts one new thread per picked model, each in its own fresh worktree,
 * while the user stays on the (cleared) draft. Picks that definitely failed
 * come back with the prompt; a pick whose request may have landed is not
 * retried and gets a toast that opens its thread instead.
 */
export function useMultiModelSend() {
  const navigate = useNavigate();
  const setStoredSelections = useMultiModelSelectionStore((state) => state.set);

  return useCallback(
    async (input: MultiModelSendInput): Promise<void> => {
      const api = readEnvironmentApi(input.environmentId);
      if (!api) return;
      const resolved = resolveMultiModelTargets({
        selections: input.selections,
        entries: input.entries,
        titleSeed: input.titleSeed,
      });
      if (!resolved.ok) {
        input.setError(resolved.error);
        return;
      }

      let attachments;
      try {
        // Read once and shared by every thread: the same images go to each model.
        attachments = await Promise.all(
          input.images.map(async (image) => ({
            type: image.type,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl: await readFileAsDataUrl(image.file),
          })),
        );
      } catch (error) {
        input.setError(error instanceof Error ? error.message : "Failed to read attachments.");
        return;
      }

      input.setError(null);
      input.clearComposer();
      const createdAt = new Date().toISOString();
      const results = await startMultiModelThreads({
        targets: resolved.targets,
        newThreadId,
        start: (target: MultiModelTarget, threadId: ThreadId) => {
          const providerState = getComposerProviderState({
            provider: target.driverKind,
            model: target.selection.model,
            models: target.models,
            prompt: input.messageText,
            modelOptions: target.selection.options,
          });
          const modelSelection = createModelSelection(
            target.selection.instanceId,
            target.selection.model,
            providerState.modelOptionsForDispatch,
          );
          return api.orchestration.dispatchCommand({
            type: "thread.turn.start",
            commandId: newCommandId(),
            threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: formatOutgoingPrompt({
                provider: target.driverKind,
                model: target.selection.model,
                models: target.models,
                effort: providerState.promptEffort,
                text: input.messageText || IMAGE_ONLY_BOOTSTRAP_PROMPT,
              }),
              attachments,
            },
            modelSelection,
            // The plain seed, not the suffixed title: the server only swaps in
            // a generated title while the title still equals the seed, and
            // that would drop the suffix telling the sibling threads apart.
            titleSeed: input.titleSeed,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            bootstrap: {
              createThread: {
                projectId: input.projectId,
                title: target.title,
                modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                branch: input.baseBranch,
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: input.projectCwd,
                baseBranch: input.baseBranch,
                branch: buildTemporaryWorktreeBranchName(randomHex),
              },
              runSetupScript: true,
            },
            createdAt,
          });
        },
      });

      const openThread = (threadId: ThreadId) =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: input.environmentId, threadId },
        });
      let startedCount = 0;
      for (const result of results) {
        if (result.status === "started") {
          startedCount += 1;
          continue;
        }
        const description =
          result.error instanceof Error ? result.error.message : "Failed to start the thread.";
        if (result.status === "not-started") {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Could not start ${result.target.label}`,
              description,
            }),
          );
          continue;
        }
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: `${result.target.label} may have started`,
            description: `${description} Check the thread before sending to this model again.`,
            timeout: 0,
            actionProps: { children: "Open thread", onClick: () => openThread(result.threadId) },
          }),
        );
      }
      if (startedCount > 0) {
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: `Started ${startedCount} ${startedCount === 1 ? "thread" : "threads"}`,
          }),
        );
      }
      if (startedCount === results.length) return;

      input.restoreComposer();
      const toRestore = resolveSelectionsToRestore(results);
      if (toRestore.length >= 2) {
        setStoredSelections(input.draftId, toRestore);
      } else {
        setStoredSelections(input.draftId, null);
        const only = toRestore[0];
        if (only) input.selectSingleModel(only.instanceId, only.model);
      }
    },
    [navigate, setStoredSelections],
  );
}
