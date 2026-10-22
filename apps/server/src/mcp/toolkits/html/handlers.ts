import {
  clampHtmlRenderHeight,
  HTML_RENDER_MAX_BYTES,
  HTML_RENDER_MAX_TITLE_LENGTH,
  injectHtmlRenderBootstrap,
} from "@t3tools/shared/htmlRender";
import * as Effect from "effect/Effect";

import { writeFileStringAtomically } from "../../../atomicWrite.ts";
import { resolveAttachmentRelativePath } from "../../../attachmentPaths.ts";
import { createAttachmentId } from "../../../attachmentStore.ts";
import { ServerConfig } from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { HtmlRenderToolError, HtmlRenderToolkit } from "./tools.ts";

const utf8ByteLength = (text: string) => new TextEncoder().encode(text).byteLength;

const handlers = {
  html_render: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const config = yield* ServerConfig;

      const title = input.title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH);
      if (title.length === 0) {
        return yield* new HtmlRenderToolError({
          message: "The title is empty. Pass a short name for the page.",
        });
      }
      if (input.html.trim().length === 0) {
        return yield* new HtmlRenderToolError({
          message: "The page is empty. Pass a complete HTML document.",
        });
      }
      const sizeBytes = utf8ByteLength(input.html);
      if (sizeBytes > HTML_RENDER_MAX_BYTES) {
        return yield* new HtmlRenderToolError({
          message: `The page is ${Math.ceil(sizeBytes / 1024)} KB; the limit is ${HTML_RENDER_MAX_BYTES / 1024} KB. Trim inline data or load large libraries from a CDN.`,
        });
      }

      const attachmentId = createAttachmentId(invocation.threadId);
      const filePath = attachmentId
        ? resolveAttachmentRelativePath({
            attachmentsDir: config.attachmentsDir,
            relativePath: `${attachmentId}.html`,
          })
        : null;
      if (!attachmentId || !filePath) {
        return yield* new HtmlRenderToolError({
          message: "This conversation cannot store pages.",
        });
      }

      yield* writeFileStringAtomically({
        filePath,
        contents: injectHtmlRenderBootstrap(input.html),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new HtmlRenderToolError({
              message: `The page could not be saved: ${cause.message}`,
            }),
        ),
      );

      return {
        htmlRender: {
          attachmentId,
          title,
          ...(input.height === undefined ? {} : { height: clampHtmlRenderHeight(input.height) }),
        },
        message:
          "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.",
      };
    }),
} satisfies Parameters<typeof HtmlRenderToolkit.toLayer>[0];

export const HtmlRenderToolkitHandlersLive = HtmlRenderToolkit.toLayer(handlers);
