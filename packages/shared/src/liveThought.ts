/**
 * The one-line "latest thought" shown beside the working indicator while an
 * agent turn runs. The server derives it from streamed reasoning and the
 * clients render it as-is.
 *
 * @module liveThought
 */

/** Longest line the server sends; the UI clamps it to two lines anyway. */
export const LIVE_THOUGHT_MAX_CHARS = 600;

/**
 * Plain-text line for a piece of reasoning. A bold-only opening line (the
 * Codex summary heading) wins; otherwise this is the first sentence of the
 * reasoning text. Markdown is flattened to plain text.
 */
export function liveThoughtLine(markdown: string): string {
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(markdown)?.[1];
  const text = (heading ?? markdown)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (heading !== undefined) return text;
  // Cut after the first . ? or ! (plus a closing quote or paren) that a space follows.
  const end = /[.?!]["'”’)]?(?=\s)/.exec(text);
  return end ? text.slice(0, end.index + end[0].length) : text;
}
