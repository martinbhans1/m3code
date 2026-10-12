import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { resolveModelSelection } from "@t3tools/shared/modelResolution";
import { readRunnableModels, runnableToSelection } from "../startingModel.ts";

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    if (command.type === "thread.create" && command.modelSelection === "default") {
      const settingsService = yield* ServerSettingsService;
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(
          () =>
            new OrchestrationDispatchCommandError({
              message: "Could not read the default model from Settings.",
            }),
        ),
      );
      // "default" asks for the user's chosen default. Its switch only decides
      // whether it beats the chat someone is in, which does not apply here.
      const configuredDefault = settings.defaultModelSelection;
      if (!configuredDefault) {
        return yield* new OrchestrationDispatchCommandError({
          message: "Choose a default model in Settings > Chat before using the default model.",
        });
      }
      // "default" is a request for the user's choice, so only their default
      // or, when the account cannot run it, one of their starred models will
      // do. Starting on whatever a provider happens to list first would be the
      // silent substitution this path exists to avoid.
      const resolution = resolveModelSelection({
        runnable: yield* readRunnableModels,
        configuredDefault,
        favorites: settings.favorites,
        toSelection: runnableToSelection,
      });
      if (resolution.outcome === "unsupported" || resolution.source === "available") {
        return yield* new OrchestrationDispatchCommandError({
          message: `The default model in Settings > Chat (${configuredDefault.model}) is not available on the connected accounts, and none of your starred models are either. Pick another default, or check the provider is signed in.`,
        });
      }
      if (resolution.skipped.length > 0) {
        yield* Effect.logInfo("default model unavailable; started on a starred model instead", {
          configured: configuredDefault.model,
          started: resolution.selection.model,
        });
      }
      return { ...command, modelSelection: resolution.selection } satisfies OrchestrationCommand;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    if (command.type === "project.create") {
      return {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          command.workspaceRoot,
          command.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: command.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (command.type === "project.meta.update" && command.workspaceRoot !== undefined) {
      return {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (command.type !== "thread.turn.start") {
      return command as OrchestrationCommand;
    }

    const normalizedAttachments = yield* Effect.forEach(
      command.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid attachment payload for '${attachment.name}'.`,
            });
          }

          const isImage = attachment.type === "image";
          if (isImage && !parsed.mimeType.startsWith("image/")) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const maxBytes = isImage
            ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
            : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(command.threadId);
          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = isImage
            ? {
                type: "image" as const,
                id: attachmentId,
                name: attachment.name,
                mimeType: parsed.mimeType.toLowerCase(),
                sizeBytes: bytes.byteLength,
              }
            : {
                type: "file" as const,
                id: attachmentId,
                name: attachment.name,
                // Prefer the client-declared MIME (the picker/drop captures the
                // OS type); fall back to the data URL's embedded type.
                mimeType: (attachment.mimeType || parsed.mimeType).toLowerCase(),
                sizeBytes: bytes.byteLength,
              };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );

    return {
      ...command,
      message: {
        ...command.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });
