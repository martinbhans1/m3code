import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

/** Highlight registry names; styled by `::highlight(...)` rules in index.css. */
export const TIMELINE_FIND_HIGHLIGHT = "timeline-find";
export const TIMELINE_FIND_CURRENT_HIGHLIGHT = "timeline-find-current";

export interface TimelineFindMatch {
  rowId: string;
  rowIndex: number;
}

/**
 * Emphasis, code and strikethrough markers never render, so a phrase running
 * across them — `the **deployment** runs` — must still match what is on screen.
 */
const MARKDOWN_EMPHASIS_MARKERS = /[*`~]/g;

function normalizeTimelineFindText(text: string): string {
  return text.replace(MARKDOWN_EMPHASIS_MARKERS, "").toLocaleLowerCase();
}

export function normalizeTimelineFindQuery(query: string): string {
  return normalizeTimelineFindText(query.trim());
}

/** The prose a row carries — the only text find searches. Tool activity is not prose. */
function searchableRowText(row: MessagesTimelineRow): string | null {
  if (row.kind === "message") {
    return row.message.role === "system" ? null : row.message.text;
  }
  if (row.kind === "proposed-plan") {
    return row.proposedPlan.planMarkdown;
  }
  return null;
}

/**
 * Rows containing the query, in transcript order. Navigation steps per row
 * rather than per occurrence: the raw text (markdown) and what renders differ,
 * so occurrence counts would not line up with what the user sees highlighted.
 */
export function findTimelineMatches(
  rows: ReadonlyArray<MessagesTimelineRow>,
  query: string,
): TimelineFindMatch[] {
  const needle = normalizeTimelineFindQuery(query);
  if (needle.length === 0) {
    return [];
  }
  const matches: TimelineFindMatch[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    const text = searchableRowText(row);
    if (text && normalizeTimelineFindText(text).includes(needle)) {
      matches.push({ rowId: row.id, rowIndex });
    }
  }
  return matches;
}

/** Wraps around in both directions; -1 when there is nothing to step through. */
export function stepTimelineFindIndex(current: number, count: number, direction: 1 | -1): number {
  if (count === 0) {
    return -1;
  }
  if (current < 0) {
    return direction === 1 ? 0 : count - 1;
  }
  return (current + direction + count) % count;
}

/**
 * Every occurrence of `needle` (already normalized) in the rendered text under
 * `root`. Text nodes are joined first so a match split across inline markup —
 * `**dep**loyment` — is still found.
 */
export function collectTextMatchRanges(root: Node, needle: string): Range[] {
  if (needle.length === 0) {
    return [];
  }
  const nodes: Text[] = [];
  const starts: number[] = [];
  let combined = "";
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    nodes.push(text);
    starts.push(combined.length);
    combined += text.data;
  }
  const haystack = combined.toLocaleLowerCase();
  // Lower-casing can change length for a few scripts; positions would drift.
  if (haystack.length !== combined.length) {
    return [];
  }

  const ranges: Range[] = [];
  let nodeIndex = 0;
  const locate = (offset: number, isEnd: boolean) => {
    while (
      nodeIndex < nodes.length - 1 &&
      (isEnd
        ? offset > starts[nodeIndex]! + nodes[nodeIndex]!.data.length
        : offset >= starts[nodeIndex]! + nodes[nodeIndex]!.data.length)
    ) {
      nodeIndex += 1;
    }
    return { node: nodes[nodeIndex]!, offset: offset - starts[nodeIndex]! };
  };
  for (
    let found = haystack.indexOf(needle);
    found !== -1;
    found = haystack.indexOf(needle, found + needle.length)
  ) {
    const start = locate(found, false);
    const end = locate(found + needle.length, true);
    const range = root.ownerDocument!.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    ranges.push(range);
  }
  return ranges;
}
