/**
 * Tool lifecycle activities carry the provider's raw `data` blob straight into
 * `projection_thread_activities` — and, because every activity is also an
 * `thread.activity-appended` event, into `orchestration_events` as well. A
 * single `take_screenshot` result is ~1 MB of base64, so it lands on disk twice
 * per emission and the store grows without bound.
 *
 * Nothing renders those bytes: the timeline pretty-prints `data.item` into an
 * expandable body (a wall of base64 is useless there), and the rest of the UI
 * only reads short scalars out of `data` — commands, tool call ids, changed
 * file paths, `rawOutput` summaries. So we keep the structure intact and cap
 * the leaves.
 */

const MAX_STRING_CHARS = 8_000;
const MAX_ARRAY_ITEMS = 200;
const MAX_DEPTH = 12;
const MAX_TOTAL_CHARS = 96_000;

/** Longest base64 run we leave alone; below this it is not worth a placeholder. */
const MIN_BASE64_CHARS = 512;

const BASE64_DATA_URL_PATTERN = /^data:([\w.+-]+\/[\w.+-]+)?;base64,/i;
const BASE64_BODY_PATTERN = /^[A-Za-z0-9+/\s]+={0,2}$/;

function formatOmittedBytes(chars: number): string {
  const bytes = Math.floor((chars * 3) / 4);
  return bytes >= 1024 ? `${Math.round(bytes / 1024).toLocaleString()} KB` : `${bytes} bytes`;
}

/**
 * Detects a base64 blob, either as a `data:` URL or as a bare payload sitting in
 * an image block's `data` field. Bare base64 is only claimed when the string is
 * long and entirely base64 alphabet, so prose and file contents are untouched.
 */
function describeBase64Blob(value: string, key: string | null): string | null {
  const dataUrlMatch = value.match(BASE64_DATA_URL_PATTERN);
  if (dataUrlMatch) {
    const mimeType = dataUrlMatch[1] ?? "application/octet-stream";
    const body = value.slice(dataUrlMatch[0].length);
    if (body.length < MIN_BASE64_CHARS) {
      return null;
    }
    return `[${mimeType} omitted, ${formatOmittedBytes(body.length)}]`;
  }

  // Anthropic-style image blocks put the raw payload under `data`/`base64`.
  if (key !== "data" && key !== "base64") {
    return null;
  }
  if (value.length < MIN_BASE64_CHARS || !BASE64_BODY_PATTERN.test(value)) {
    return null;
  }
  return `[binary omitted, ${formatOmittedBytes(value.length)}]`;
}

function truncateString(value: string, key: string | null): string {
  const base64Placeholder = describeBase64Blob(value, key);
  if (base64Placeholder !== null) {
    return base64Placeholder;
  }
  if (value.length <= MAX_STRING_CHARS) {
    return value;
  }
  const omitted = value.length - MAX_STRING_CHARS;
  return `${value.slice(0, MAX_STRING_CHARS)}… [truncated ${omitted.toLocaleString()} chars]`;
}

function sanitizeValue(value: unknown, key: string | null, depth: number): unknown {
  if (typeof value === "string") {
    return truncateString(value, key);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return Array.isArray(value) ? `[array omitted, ${value.length} items]` : "[object omitted]";
  }

  if (Array.isArray(value)) {
    const kept = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, null, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      kept.push(`[${value.length - MAX_ARRAY_ITEMS} more items omitted]`);
    }
    return kept;
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const entryKey of Object.keys(source)) {
    result[entryKey] = sanitizeValue(source[entryKey], entryKey, depth + 1);
  }
  return result;
}

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    // Circular or otherwise unserializable — the projection would fail on it
    // anyway, so treat it as oversized and let the caller drop it.
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Caps a tool lifecycle `data` blob before it is persisted. Object and array
 * structure is preserved so the UI's field extraction keeps working; only
 * oversized leaves are replaced.
 */
export function sanitizeToolActivityData(data: unknown): unknown {
  if (data === undefined) {
    return undefined;
  }

  const sanitized = sanitizeValue(data, null, 0);
  const length = serializedLength(sanitized);
  if (length <= MAX_TOTAL_CHARS) {
    return sanitized;
  }

  // Still oversized after per-leaf capping — a wide structure rather than a few
  // big blobs. Keep the top-level shape so extraction has something to read.
  if (sanitized === null || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return `[payload omitted, ${length.toLocaleString()} chars]`;
  }

  const source = sanitized as Record<string, unknown>;
  const trimmed: Record<string, unknown> = {};
  let budget = MAX_TOTAL_CHARS;
  for (const key of Object.keys(source)) {
    const entryLength = serializedLength(source[key]) + key.length + 4;
    if (entryLength > budget) {
      trimmed[key] = "[omitted, payload too large]";
      continue;
    }
    budget -= entryLength;
    trimmed[key] = source[key];
  }
  return trimmed;
}

export const TOOL_ACTIVITY_PAYLOAD_LIMITS = {
  maxStringChars: MAX_STRING_CHARS,
  maxArrayItems: MAX_ARRAY_ITEMS,
  maxDepth: MAX_DEPTH,
  maxTotalChars: MAX_TOTAL_CHARS,
} as const;
