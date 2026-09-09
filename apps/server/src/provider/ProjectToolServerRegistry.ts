/**
 * The extra MCP servers configured for a project, held where a provider adapter
 * can read them when it starts a session.
 *
 * Same shape and same reason as `McpProviderSession`: an adapter builds its
 * server list deep inside `startSession`, where adding a service dependency
 * would ripple through every driver's type. A module-level snapshot, refreshed
 * whenever settings change, keeps that list current without any of that.
 *
 * Read at session start, which is the only moment it can matter — a running
 * session's tool list is fixed for its lifetime, so a server added now reaches
 * a conversation when its session is next built, not mid-turn.
 *
 * @module ProjectToolServerRegistry
 */
import type { ProjectToolServerConfig } from "@t3tools/contracts";

let configuredServers: ReadonlyArray<ProjectToolServerConfig> = [];

export function setProjectToolServers(servers: ReadonlyArray<ProjectToolServerConfig>): void {
  configuredServers = servers;
}

export function readProjectToolServers(): ReadonlyArray<ProjectToolServerConfig> {
  return configuredServers;
}

export function clearProjectToolServers(): void {
  configuredServers = [];
}
