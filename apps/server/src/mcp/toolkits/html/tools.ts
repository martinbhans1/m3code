import {
  HTML_RENDER_MAX_BYTES,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_KEY_LENGTH,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_THEME_VARIABLES,
  HTML_RENDER_TOOL_NAME,
} from "@t3tools/shared/htmlRender";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { ServerConfig } from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export class HtmlRenderToolError extends Schema.TaggedErrorClass<HtmlRenderToolError>()(
  "HtmlRenderToolError",
  { message: Schema.String },
) {}

export const HtmlRenderInput = Schema.Struct({
  html: Schema.String.annotate({
    description: `A complete, self-contained HTML document, at most ${HTML_RENDER_MAX_BYTES / 1024} KB.`,
  }),
  title: Schema.String.annotate({
    description: `Short name for the page, at most ${HTML_RENDER_MAX_TITLE_LENGTH} characters.`,
  }),
  height: Schema.optional(
    Schema.Number.annotate({
      description: `The most the frame may take, in CSS pixels, ${HTML_RENDER_MIN_HEIGHT}-${HTML_RENDER_MAX_HEIGHT}. Omit it to fit the page; anything taller scrolls inside the frame.`,
    }),
  ),
  key: Schema.optional(
    Schema.String.annotate({
      description: `A stable name for a page you may revise, such as "pricing-mockup": letters, digits, dots, dashes and underscores, at most ${HTML_RENDER_MAX_KEY_LENGTH} characters. Calling again with the same key replaces that page with a new version instead of adding another page; the reader can still step back to earlier versions.`,
    }),
  ),
  panel: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Also open the page in the panel beside the conversation. Use it for something the reader will keep referring to while you talk, or that you expect to revise.",
    }),
  ),
});

export const HtmlRenderResult = Schema.Struct({
  htmlRender: Schema.Struct({
    attachmentId: Schema.String,
    title: Schema.String,
    height: Schema.optional(Schema.Number),
    key: Schema.optional(Schema.String),
    panel: Schema.optional(Schema.Boolean),
  }),
  message: Schema.String,
});

// Read-only in the MCP sense: it shows a page in the caller's own thread and
// touches no workspace, so plan mode and read-only sandboxes can use it.
// Open-world, since the page may load remote resources.
export const HtmlRenderTool = Tool.make(HTML_RENDER_TOOL_NAME, {
  description: [
    "Show a finished HTML page — a chart, table, diagram, mockup or small interactive widget — inline in this conversation, above your reply. Call it before writing the reply; the reader already sees the page, so don't announce or restate it.",
    "Write one self-contained document with inline <style> and <script>; remote http(s) resources such as a CDN chart library load as-is. The page runs sandboxed: no cookies, storage, alerts or popups, and links open in the reader's browser.",
    "Use a fluid width with no outer card or border; the frame sits in the reply column and fits the page's height.",
    "Every page stays listed in the panel beside the conversation, so the reader can reopen it later without scrolling back. To change a page you already showed, call again with the same key rather than showing a second page.",
    `M3 Code sets its theme as CSS variables on :root that follow light and dark mode: ${HTML_RENDER_THEME_VARIABLES.join(", ")}. Style against them so the page matches the app.`,
  ].join(" "),
  parameters: HtmlRenderInput,
  success: HtmlRenderResult,
  failure: HtmlRenderToolError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ServerConfig,
    FileSystem.FileSystem,
    Path.Path,
  ],
})
  .annotate(Tool.Title, "Show an HTML page")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const HtmlRenderToolkit = Toolkit.make(HtmlRenderTool);
