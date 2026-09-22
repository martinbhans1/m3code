import type { ProjectToolServerConfig, ProjectToolServerId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeToolServerReach,
  hasStoredToolServerCredential,
  newProjectToolServerId,
  resolvePublishableToolServers,
  toToolServerEntries,
  toolServerNameIssue,
  toolServerUrlIssue,
  type ProjectToolServerEntry,
} from "./projectToolServers.logic";

const serverId = (value: string) => value as ProjectToolServerId;

function makeRow(overrides: Partial<ProjectToolServerEntry> = {}): ProjectToolServerEntry {
  return {
    id: serverId("tsone"),
    label: "Team chat",
    name: "team-chat",
    projectPath: "C:/repos/dealjourney",
    url: "https://tools.example.com/mcp",
    authHeader: "Authorization",
    authValue: "",
    enabled: true,
    ...overrides,
  };
}

describe("toolServerNameIssue", () => {
  it("accepts a name the agent could quote back", () => {
    expect(toolServerNameIssue("team-chat")).toBeNull();
  });

  it("rejects a name with a space or a leading digit", () => {
    expect(toolServerNameIssue("team chat")).not.toBeNull();
    expect(toolServerNameIssue("1chat")).not.toBeNull();
  });

  it("rejects the names the app already uses for its own tools", () => {
    expect(toolServerNameIssue("t3-code")).not.toBeNull();
    expect(toolServerNameIssue("t3-code-orchestrator")).not.toBeNull();
    expect(toolServerNameIssue("chrome-devtools")).not.toBeNull();
  });
});

describe("toolServerUrlIssue", () => {
  it("accepts http and https endpoints", () => {
    expect(toolServerUrlIssue("https://tools.example.com/mcp")).toBeNull();
    expect(toolServerUrlIssue("http://localhost:8123/mcp")).toBeNull();
  });

  it("rejects anything that is not a web address", () => {
    expect(toolServerUrlIssue("tools.example.com")).not.toBeNull();
    expect(toolServerUrlIssue("ws://tools.example.com")).not.toBeNull();
  });
});

describe("hasStoredToolServerCredential", () => {
  it("counts a redacted entry as having a credential", () => {
    expect(hasStoredToolServerCredential(makeRow({ authValue: "", authValueRedacted: true }))).toBe(
      true,
    );
  });

  it("counts a blank entry with no redaction flag as having none", () => {
    expect(hasStoredToolServerCredential(makeRow({ authValue: "" }))).toBe(false);
    expect(hasStoredToolServerCredential(undefined)).toBe(false);
  });
});

describe("describeToolServerReach", () => {
  it("warns that a shared server reaches every conversation", () => {
    expect(
      describeToolServerReach({
        enabled: true,
        name: "team-chat",
        url: "https://tools.example.com/mcp",
        projectLabel: "Every project",
        isSharedWithEveryProject: true,
      }),
    ).toContain("every conversation");
  });

  it("names the project a scoped server reaches", () => {
    expect(
      describeToolServerReach({
        enabled: true,
        name: "team-chat",
        url: "https://tools.example.com/mcp",
        projectLabel: "dealjourney",
        isSharedWithEveryProject: false,
      }),
    ).toContain("dealjourney");
  });

  it("explains a disabled or unusable entry instead of promising reach", () => {
    expect(
      describeToolServerReach({
        enabled: false,
        name: "team-chat",
        url: "https://tools.example.com/mcp",
        projectLabel: "dealjourney",
        isSharedWithEveryProject: false,
      }),
    ).toContain("Off");
    expect(
      describeToolServerReach({
        enabled: true,
        name: "team-chat",
        url: "",
        projectLabel: "dealjourney",
        isSharedWithEveryProject: false,
      }),
    ).toBe(toolServerUrlIssue(""));
  });
});

describe("resolvePublishableToolServers", () => {
  it("holds back a new entry that has not been named yet", () => {
    const rows = [makeRow({ id: serverId("tsnew"), label: "", name: "" })];
    expect(resolvePublishableToolServers(rows, {})).toEqual({});
  });

  it("keeps the stored label and name when the fields are cleared mid-edit", () => {
    const saved: Record<string, ProjectToolServerConfig> = {
      tsone: {
        label: "Team chat",
        name: "team-chat",
        projectPath: "C:/repos/dealjourney",
        url: "https://tools.example.com/mcp",
        authHeader: "Authorization",
        authValue: "",
        authValueRedacted: true,
        enabled: true,
      },
    };
    const published = resolvePublishableToolServers(
      [makeRow({ label: "", name: "", url: "https://tools.example.com/v2" })],
      saved,
    );
    expect(published[serverId("tsone")]).toMatchObject({
      label: "Team chat",
      name: "team-chat",
      url: "https://tools.example.com/v2",
    });
  });

  it("drops a removed entry rather than resurrecting it from the saved map", () => {
    const saved: Record<string, ProjectToolServerConfig> = {
      tsone: {
        label: "Team chat",
        name: "team-chat",
        projectPath: "",
        url: "https://tools.example.com/mcp",
        authHeader: "Authorization",
        authValue: "",
        enabled: true,
      },
    };
    expect(resolvePublishableToolServers([], saved)).toEqual({});
  });

  it("strips the id from every published entry", () => {
    const published = resolvePublishableToolServers([makeRow()], {});
    expect(published[serverId("tsone")]).not.toHaveProperty("id");
  });
});

describe("toToolServerEntries and ids", () => {
  it("carries the map key onto each entry", () => {
    const entries = toToolServerEntries({
      tsone: makeRow() as ProjectToolServerConfig,
    });
    expect(entries.map((entry) => entry.id)).toEqual([serverId("tsone")]);
  });

  it("mints ids that satisfy the contract slug pattern", () => {
    expect(newProjectToolServerId()).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
  });
});
