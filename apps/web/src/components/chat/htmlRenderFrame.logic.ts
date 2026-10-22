import {
  HTML_RENDER_THEME_VARIABLES,
  readHtmlRenderFrameMessage,
  type HtmlRenderTheme,
} from "@t3tools/shared/htmlRender";

export type HtmlRenderFrameAction =
  | { readonly kind: "resize"; readonly height: number }
  | { readonly kind: "open-link"; readonly url: string };

/**
 * What to do about a `message` event, if it came from this frame's page.
 *
 * Only the frame's own window is listened to — any other window, including
 * another page's frame, can post here too. A link opens only while the reader
 * has just interacted (a click inside the frame counts, since user activation
 * reaches the frame's ancestors), so a page cannot open tabs on its own.
 */
export function resolveHtmlRenderFrameMessage(input: {
  readonly source: unknown;
  readonly frameWindow: unknown;
  readonly data: unknown;
  readonly userActive: boolean;
}): HtmlRenderFrameAction | null {
  if (input.frameWindow == null || input.source !== input.frameWindow) return null;
  const message = readHtmlRenderFrameMessage(input.data);
  if (!message) return null;
  if (message.kind === "size") return { kind: "resize", height: message.height };
  return input.userActive ? { kind: "open-link", url: message.url } : null;
}

/** The app's current theme, as the variables a page styles against. */
export function readHtmlRenderTheme(
  root: Element,
  appearance: HtmlRenderTheme["appearance"],
): HtmlRenderTheme {
  const computed = getComputedStyle(root);
  const variables: Record<string, string> = {};
  for (const name of HTML_RENDER_THEME_VARIABLES) {
    const value = computed.getPropertyValue(name).trim();
    if (value) variables[name] = value;
  }
  return { appearance, variables };
}
