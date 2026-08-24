import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import { ProviderInstanceId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApi } from "../environmentApi";
import { newCommandId, newProjectId } from "../lib/utils";
import { getServerConfig } from "../rpc/serverState";
import {
  selectProjectsAcrossEnvironments,
  selectThreadShellsAcrossEnvironments,
  useStore,
} from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { useHandleNewThread } from "./useHandleNewThread";
import { useSettings, useUpdateSettings } from "./useSettings";

export const ORCHESTRATOR_PROJECT_TITLE = "Orchestrator";

/**
 * The orchestrator's tools only exist on the Claude provider, so the meta
 * conversation pins itself to Claude rather than inheriting the global default.
 * On any other provider the thread would open with no tools at all and simply
 * look broken.
 */
const ORCHESTRATOR_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5",
  options: [{ id: "effort", value: "medium" }],
} as const;

export interface OpenOrchestratorConversationOptions {
  /**
   * Force a new conversation instead of resuming the most recent one. The row
   * in the sidebar is permanent; the thread behind it is not, because a single
   * conversation kept forever only grows.
   */
  readonly startFresh?: boolean;
}

/**
 * Opens the meta conversation, creating whatever is missing on the way.
 *
 * Nothing exists until the row is first clicked: no project, no directory, no
 * thread. That keeps the feature free for anyone who never opens it, and means
 * there is no setup for anyone who does.
 */
export function useOpenOrchestratorConversation() {
  const orchestratorProjectId = useSettings((settings) => settings.orchestratorProjectId);
  const { updateSettings } = useUpdateSettings();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threadShells = useStore(useShallow(selectThreadShellsAcrossEnvironments));
  const { handleNewThread } = useHandleNewThread();
  const navigate = useNavigate();

  return useCallback(
    async (options: OpenOrchestratorConversationOptions = {}): Promise<void> => {
      const serverConfig = getServerConfig();
      if (!serverConfig) return;
      // A backend older than this feature does not send the field, and the
      // resulting `workspaceRoot: undefined` fails command validation with an
      // error that says nothing useful. Name the real problem instead.
      if (!serverConfig.orchestratorWorkspaceRoot) {
        throw new Error(
          "This backend is older than the orchestrator and cannot create its workspace. Restart the app so the server picks up the current build.",
        );
      }
      const environmentId = serverConfig.environment.environmentId as EnvironmentId;
      const api = readEnvironmentApi(environmentId);
      if (!api) return;

      // The setting is bookkeeping, not a preference: it records which project
      // was created for this purpose. A stale id (project deleted) falls
      // through to creating a new one.
      const existingProject = orchestratorProjectId
        ? (projects.find(
            (project) =>
              project.id === orchestratorProjectId && project.environmentId === environmentId,
          ) ?? null)
        : null;

      let projectId: ProjectId;
      if (existingProject) {
        projectId = existingProject.id;
        if (
          existingProject.defaultModelSelection?.model !== ORCHESTRATOR_MODEL_SELECTION.model ||
          existingProject.defaultModelSelection.options?.some(
            (option) => option.id === "effort" && option.value === "medium",
          ) !== true
        ) {
          await api.orchestration.dispatchCommand({
            type: "project.meta.update",
            commandId: newCommandId(),
            projectId,
            defaultModelSelection: ORCHESTRATOR_MODEL_SELECTION,
          });
        }
      } else {
        projectId = newProjectId();
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title: ORCHESTRATOR_PROJECT_TITLE,
          workspaceRoot: serverConfig.orchestratorWorkspaceRoot,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: ORCHESTRATOR_MODEL_SELECTION,
          createdAt: new Date().toISOString(),
        });
        updateSettings({ orchestratorProjectId: projectId });
      }

      if (options.startFresh !== true) {
        const latest = threadShells
          .filter(
            (thread) =>
              thread.environmentId === environmentId &&
              thread.projectId === projectId &&
              thread.archivedAt === null,
          )
          .toSorted((left, right) =>
            (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
          )[0];
        if (latest) {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(environmentId, latest.id)),
          });
          return;
        }
      }

      // Local, never a worktree: there is no repository here to branch.
      await handleNewThread(scopeProjectRef(environmentId, projectId), {
        envMode: "local",
      });
    },
    [handleNewThread, navigate, orchestratorProjectId, projects, threadShells, updateSettings],
  );
}

/**
 * The orchestrator project is an implementation detail of the sidebar row, so
 * it is filtered out of the normal project tree. Without this it shows up as a
 * mystery empty project pointing into the app's state directory.
 */
export function useOrchestratorProjectId(): ProjectId | null {
  return useSettings((settings) => settings.orchestratorProjectId);
}
