import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveIdleCompaction } from "./idleCompaction.ts";

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CLAUDE_WORK = ProviderInstanceId.make("claude-work");

describe("resolveIdleCompaction", () => {
  it("is off by default", () => {
    expect(resolveIdleCompaction(DEFAULT_SERVER_SETTINGS, CLAUDE)).toBe("off");
  });

  it("follows the global setting when the instance says default", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      compactIdleThreads: "beforeCacheExpires" as const,
    };
    expect(resolveIdleCompaction(settings, CLAUDE)).toBe("beforeCacheExpires");
    expect(
      resolveIdleCompaction(
        {
          ...settings,
          providerInstances: {
            [CLAUDE_WORK]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { idleCompaction: "default" },
            },
          },
        },
        CLAUDE_WORK,
      ),
    ).toBe("beforeCacheExpires");
  });

  it("lets an explicit instance override the global setting either way", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      compactIdleThreads: "beforeCacheExpires" as const,
      providerInstances: {
        [CLAUDE_WORK]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { idleCompaction: "off" },
        },
      },
    };
    expect(resolveIdleCompaction(settings, CLAUDE_WORK)).toBe("off");
    expect(
      resolveIdleCompaction(
        {
          ...settings,
          compactIdleThreads: "off",
          providerInstances: {
            [CLAUDE_WORK]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { idleCompaction: "beforeCacheExpires" },
            },
          },
        },
        CLAUDE_WORK,
      ),
    ).toBe("beforeCacheExpires");
  });

  it("reads the default Claude slot from the legacy provider settings", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      compactIdleThreads: "off" as const,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        claudeAgent: {
          ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
          idleCompaction: "beforeCacheExpires" as const,
        },
      },
    };
    expect(resolveIdleCompaction(settings, CLAUDE)).toBe("beforeCacheExpires");
    // A different instance does not inherit the default slot's override.
    expect(resolveIdleCompaction(settings, CLAUDE_WORK)).toBe("off");
  });

  it("falls back to the global setting for an unreadable instance config", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      compactIdleThreads: "beforeCacheExpires" as const,
      providerInstances: {
        [CLAUDE_WORK]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { idleCompaction: "sometimes" },
        },
      },
    };
    expect(resolveIdleCompaction(settings, CLAUDE_WORK)).toBe("beforeCacheExpires");
  });
});
