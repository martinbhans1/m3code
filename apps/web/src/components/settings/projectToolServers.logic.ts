import type { ProjectToolServerConfig, ProjectToolServerId } from "@t3tools/contracts";

/** A configured tool server plus the id it is stored under. */
export interface ProjectToolServerEntry extends ProjectToolServerConfig {
  readonly id: ProjectToolServerId;
}

/**
 * Names the app already uses for its own tool servers. A configured server that
 * took one of them would replace the surface the conversation itself runs on,
 * so the agent-side code ignores it — better to say so in the form than to let
 * someone save an entry that silently never appears.
 */
const RESERVED_TOOL_SERVER_NAMES: ReadonlySet<string> = new Set([
  "chrome-devtools",
  "t3-code",
  "t3-code-orchestrator",
]);

/** Mirrors the contract pattern: a leading letter, then letters, digits, `_`, `-`. */
const TOOL_SERVER_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const TOOL_SERVER_NAME_MAX_CHARS = 64;

export function toToolServerEntries(
  servers: Readonly<Record<string, ProjectToolServerConfig>>,
): ReadonlyArray<ProjectToolServerEntry> {
  return Object.entries(servers).map(([id, server]) => ({
    ...server,
    id: id as ProjectToolServerId,
  }));
}

export function toToolServerMap(
  rows: ReadonlyArray<ProjectToolServerEntry>,
): Record<ProjectToolServerId, ProjectToolServerConfig> {
  const next: Record<string, ProjectToolServerConfig> = {};
  for (const { id, ...server } of rows) {
    next[id] = server;
  }
  return next as Record<ProjectToolServerId, ProjectToolServerConfig>;
}

const TOOL_SERVER_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Ids must match the contract slug pattern: leading letter, then [A-Za-z0-9_-]. */
export function newProjectToolServerId(): ProjectToolServerId {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => TOOL_SERVER_ID_ALPHABET[byte % 36]).join("");
  return `ts${suffix}` as ProjectToolServerId;
}

/**
 * A saved entry arrives as `{ authValue: "", authValueRedacted: true }`. Writing
 * it back untouched is what keeps the stored credential in place; sending an
 * empty value without the flag is what tells the server to forget it.
 */
export function hasStoredToolServerCredential(
  server: ProjectToolServerConfig | undefined,
): boolean {
  if (!server) return false;
  return server.authValueRedacted === true || server.authValue.length > 0;
}

/** Human explanation of why a name would not work, or `null` when it is fine. */
export function toolServerNameIssue(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Give the server a name so conversations can call its tools.";
  if (trimmed.length > TOOL_SERVER_NAME_MAX_CHARS) return "That name is too long.";
  if (!TOOL_SERVER_NAME_PATTERN.test(trimmed)) {
    return "Use a letter first, then letters, numbers, dashes or underscores — no spaces.";
  }
  if (RESERVED_TOOL_SERVER_NAMES.has(trimmed)) {
    return "That name belongs to the app's own tools. Pick another.";
  }
  return null;
}

/** Human explanation of why an address would not work, or `null` when it is fine. */
export function toolServerUrlIssue(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return "Add the address the tools are served from.";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "That does not look like a web address.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "The address has to start with http:// or https://.";
  }
  return null;
}

/**
 * One sentence a non-engineer can act on: who gets these tools, or what is
 * stopping them from being handed out.
 */
export function describeToolServerReach(input: {
  readonly enabled: boolean;
  readonly name: string;
  readonly url: string;
  readonly projectLabel: string;
  readonly isSharedWithEveryProject: boolean;
}): string {
  if (!input.enabled) return "Off. Kept here, but not offered to any conversation.";
  const nameIssue = toolServerNameIssue(input.name);
  if (nameIssue !== null) return nameIssue;
  const urlIssue = toolServerUrlIssue(input.url);
  if (urlIssue !== null) return urlIssue;
  return input.isSharedWithEveryProject
    ? "Offered to every conversation, in every project — each one pays for these tools in context."
    : `Offered to conversations working in ${input.projectLabel}.`;
}

/**
 * The map to send to the server.
 *
 * A blank label or an unusable name fails the contract, and a rejected patch
 * would silently discard edits to every *other* entry, deletions included. So
 * each bad field is resolved on its own: a never-saved entry is held back until
 * it is filled in, while a saved one keeps what is already stored, meaning
 * clearing a field can never delete a working server.
 */
export function resolvePublishableToolServers(
  rows: ReadonlyArray<ProjectToolServerEntry>,
  saved: Readonly<Record<string, ProjectToolServerConfig>>,
): Record<ProjectToolServerId, ProjectToolServerConfig> {
  const publishable = rows.flatMap((row) => {
    const savedServer = saved[row.id];
    const label = row.label.trim().length > 0 ? row.label : (savedServer?.label ?? "");
    const name = toolServerNameIssue(row.name) === null ? row.name : (savedServer?.name ?? "");
    if (label.trim().length === 0 || name.trim().length === 0) return [];
    return [{ ...row, label, name }];
  });
  return toToolServerMap(publishable);
}
