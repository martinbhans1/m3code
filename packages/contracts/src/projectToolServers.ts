/**
 * Project tool servers — extra MCP servers handed to the conversations of one
 * project, configured from the app rather than from files on disk.
 *
 * The gap this closes: a tool server wired into a repo's own `.mcp.json` is
 * only ever mounted for conversations working in that repo. Anything else —
 * most importantly the orchestrator, which works in its own workspace and is
 * the surface most likely to need a tracker or a team chat — cannot see it, and
 * the only fix was hand-written config in a folder nobody would think to look
 * in. Configured here, a server is visible in settings, survives a workspace
 * being recreated, and can be pointed at whichever project should carry it.
 *
 * The credential never lives in `settings.json`: the server moves it into the
 * secret store and blanks the field before the snapshot reaches a client,
 * exactly as it does for database connection strings and sensitive provider
 * environment variables.
 *
 * @module projectToolServers
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

const PROJECT_TOOL_SERVER_ID_MAX_CHARS = 64;
const PROJECT_TOOL_SERVER_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const PROJECT_TOOL_SERVER_LABEL_MAX_CHARS = 120;
/**
 * The name the agent sees the server under, and the prefix of every tool it
 * offers. Constrained the way MCP server names are: an agent that has to quote
 * a tool name back cannot be asked to escape one.
 */
const PROJECT_TOOL_SERVER_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const PROJECT_TOOL_SERVER_NAME_MAX_CHARS = 64;

export const ProjectToolServerId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_TOOL_SERVER_ID_MAX_CHARS),
  Schema.isPattern(PROJECT_TOOL_SERVER_ID_PATTERN),
).pipe(Schema.brand("ProjectToolServerId"));
export type ProjectToolServerId = typeof ProjectToolServerId.Type;

export const ProjectToolServerConfig = Schema.Struct({
  /** Human label shown in settings (e.g. "DealJourney team chat"). */
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_TOOL_SERVER_LABEL_MAX_CHARS)),
  /**
   * The name the agent sees. Tools arrive as `mcp__<name>__<tool>`, so this is
   * what the conversation will call the server in its own words.
   */
  name: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_TOOL_SERVER_NAME_MAX_CHARS),
    Schema.isPattern(PROJECT_TOOL_SERVER_NAME_PATTERN),
  ),
  /**
   * Absolute path of the project whose conversations get this server. An empty
   * string means every project — deliberate, but rarely what you want: a tool
   * every conversation carries is a tool every conversation pays for in context.
   */
  projectPath: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** The MCP endpoint, `http://` or `https://`. */
  url: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * Header the credential is sent in. Defaults to `Authorization`, where the
   * value is normally `Bearer <token>`; servers that want their own header
   * (`X-API-Key`, `X-Service-Key`) set it here.
   */
  authHeader: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("Authorization"))),
  /**
   * The credential. Blank in any snapshot handed to a client —
   * `authValueRedacted` tells the UI that a value exists server-side.
   */
  authValue: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  authValueRedacted: Schema.optionalKey(Schema.Boolean),
  /**
   * Off means configured but not mounted. Kept rather than deleted so a server
   * can be parked without losing its credential.
   */
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ProjectToolServerConfig = typeof ProjectToolServerConfig.Type;

/**
 * Whether a server should be mounted for a conversation working in `cwd`.
 *
 * Prefix matching rather than equality, because a conversation often runs in a
 * worktree or a subdirectory of its project and is no less that project's
 * conversation for it. Comparison is case-insensitive and separator-agnostic:
 * the same folder reaches this code as `C:\Users\...` from one caller and
 * `C:/Users/...` from another, and a tool that silently failed to mount on one
 * of those spellings would be the hardest kind of bug to see.
 */
export function projectToolServerMatchesPath(
  server: Pick<ProjectToolServerConfig, "projectPath">,
  cwd: string | null | undefined,
): boolean {
  const scope = normalizeToolServerPath(server.projectPath);
  if (scope.length === 0) return true;
  const target = normalizeToolServerPath(cwd ?? "");
  if (target.length === 0) return false;
  return target === scope || target.startsWith(`${scope}/`);
}

function normalizeToolServerPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}
