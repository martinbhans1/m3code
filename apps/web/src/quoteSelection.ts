/**
 * Select-to-quote: selecting text in a chat message surfaces a "Quote" button
 * that drops the selection into the composer wrapped in <quote> tags. The tags
 * are sent to the model verbatim (XML delimits the quote unambiguously), while
 * both the composer and the timeline render them as quote blocks — the composer
 * as an atomic quote card, the timeline as a markdown blockquote.
 */

const QUOTE_OPEN_TAG = "<quote>";
const QUOTE_CLOSE_TAG = "</quote>";

const QUOTE_BLOCK_PATTERN = /<quote>\r?\n?([\s\S]*?)\r?\n?<\/quote>/;

function quoteBlockRegex(): RegExp {
  return new RegExp(QUOTE_BLOCK_PATTERN.source, "g");
}

export interface QuoteBlockMatch {
  /** Index of the `<quote>` tag within the searched text. */
  start: number;
  /** Index just past the `</quote>` tag. */
  end: number;
  /** The full `<quote>…</quote>` source, tags included. */
  source: string;
  /** The quoted text without the tags or their surrounding newlines. */
  body: string;
}

/**
 * Locate every `<quote>…</quote>` block in a piece of text. Shared by the
 * composer (which renders each block as a quote card) and the timeline (which
 * rewrites them into markdown blockquotes) so both agree on what a quote is.
 */
export function findQuoteBlocks(text: string): QuoteBlockMatch[] {
  if (!text.includes(QUOTE_OPEN_TAG)) {
    return [];
  }
  const matches: QuoteBlockMatch[] = [];
  const regex = quoteBlockRegex();
  let match = regex.exec(text);
  while (match !== null) {
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      source: match[0],
      body: (match[1] ?? "").replace(/\r/g, ""),
    });
    match = regex.exec(text);
  }
  return matches;
}

/**
 * Build the text to append to the composer for a quoted selection.
 * Returns null when the selection is effectively empty.
 */
export function buildQuoteInsertion(existingPrompt: string, selectedText: string): string | null {
  const normalized = selectedText.replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) {
    return null;
  }
  const needsLeadingNewline = existingPrompt.length > 0 && !existingPrompt.endsWith("\n");
  return `${needsLeadingNewline ? "\n" : ""}${QUOTE_OPEN_TAG}\n${normalized}\n${QUOTE_CLOSE_TAG}\n`;
}

/**
 * Render <quote> blocks in a user message as markdown blockquotes. Without
 * this the sanitize pipeline strips the unknown tag and the quote loses all
 * visual distinction. Text without quote tags passes through untouched.
 */
export function formatQuoteBlocksForDisplay(text: string): string {
  if (!text.includes(QUOTE_OPEN_TAG)) {
    return text;
  }
  return text.replace(quoteBlockRegex(), (match, inner: string, offset: number) => {
    const quotedLines = inner
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    // Blockquotes need blank-line separation from surrounding text, otherwise
    // markdown lazy continuation pulls the following paragraph into the quote.
    const previousChar = offset > 0 ? text[offset - 1] : "\n";
    const prefix = previousChar === "\n" ? "" : "\n";
    const nextChar = text[offset + match.length];
    const suffix = nextChar === undefined || nextChar === "\n" ? "\n" : "\n\n";
    return `${prefix}${quotedLines}${suffix}`;
  });
}
