import "../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelCapabilities } from "@t3tools/shared/model";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  FollowupCustomStartDialog,
  type FollowupCustomStartOptions,
} from "./FollowupCustomStartDialog";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { __resetLocalApiForTests } from "../../localApi";
import type { FollowupState } from "~/session-logic";

// The embedded model picker reaches for the primary environment connection to
// read and write favorites; without this it throws on mount.
vi.mock("../../environments/runtime", () => {
  const primaryConnection = {
    kind: "primary" as const,
    knownEnvironment: {
      id: "environment-local",
      label: "Local environment",
      source: "manual" as const,
      environmentId: EnvironmentId.make("environment-local"),
      target: { httpBaseUrl: "http://localhost:3000", wsBaseUrl: "ws://localhost:3000" },
    },
    environmentId: EnvironmentId.make("environment-local"),
    client: { server: { getConfig: vi.fn(), updateSettings: vi.fn() } },
    ensureBootstrapped: async () => undefined,
    reconnect: async () => undefined,
    dispose: async () => undefined,
  };

  return {
    getEnvironmentHttpBaseUrl: () => "http://localhost:3000",
    getSavedEnvironmentRecord: () => null,
    getSavedEnvironmentRuntimeState: () => null,
    hasSavedEnvironmentRegistryHydrated: () => true,
    listSavedEnvironmentRecords: () => [],
    resetSavedEnvironmentRegistryStoreForTests: vi.fn(),
    resetSavedEnvironmentRuntimeStoreForTests: vi.fn(),
    resolveEnvironmentHttpUrl: (_environmentId: unknown, path: string) =>
      new URL(path, "http://localhost:3000").toString(),
    waitForSavedEnvironmentRegistryHydration: async () => undefined,
    addSavedEnvironment: vi.fn(),
    disconnectSavedEnvironment: vi.fn(),
    ensureEnvironmentConnectionBootstrapped: async () => undefined,
    getPrimaryEnvironmentConnection: () => primaryConnection,
    readEnvironmentConnection: () => primaryConnection,
    reconnectSavedEnvironment: vi.fn(),
    removeSavedEnvironment: vi.fn(),
    requireEnvironmentConnection: () => primaryConnection,
    resetEnvironmentServiceForTests: vi.fn(),
    startEnvironmentConnectionService: vi.fn(),
    subscribeEnvironmentConnections: () => () => {},
    useSavedEnvironmentRegistryStore: (
      selector: (state: { byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
    useSavedEnvironmentRuntimeStore: (
      selector: (state: { byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
  };
});

const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

function model(slug: string, name: string): ServerProvider["models"][number] {
  return {
    slug,
    name,
    isCustom: false,
    capabilities: createModelCapabilities({ optionDescriptors: [] }),
  };
}

const TEST_PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    driver: ProviderDriverKind.make("codex"),
    instanceId: CODEX_INSTANCE_ID,
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-03T10:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: [model("gpt-5-codex", "GPT-5 Codex")],
  },
  {
    driver: ProviderDriverKind.make("claudeAgent"),
    instanceId: CLAUDE_INSTANCE_ID,
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-03T10:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: [model("claude-opus-4-6", "Claude Opus 4.6")],
  },
];

const FOLLOWUP: FollowupState = {
  id: "a",
  title: "Fix timeline scroll jump on streaming appends",
  detail: null,
  rationale: null,
  status: "pending",
  turnId: null,
  createdAt: "2026-08-03T10:00:00.000Z",
  updatedAt: "2026-08-03T10:00:00.000Z",
};

const DEFAULT_SELECTION = { instanceId: CODEX_INSTANCE_ID, model: "gpt-5-codex" };

async function mountDialog(overrides?: { canRunInCurrentChat?: boolean }) {
  const host = document.createElement("div");
  document.body.append(host);
  const onStart = vi.fn<(followup: FollowupState, options: FollowupCustomStartOptions) => void>();
  const instanceEntries = sortProviderInstanceEntries(
    deriveProviderInstanceEntries(TEST_PROVIDERS),
  );
  const screen = await render(
    <FollowupCustomStartDialog
      followup={FOLLOWUP}
      open
      onOpenChange={() => {}}
      canStartInWorktree
      canRunInCurrentChat={overrides?.canRunInCurrentChat ?? true}
      instanceEntries={instanceEntries}
      modelOptionsByInstance={getCustomModelOptionsByInstance(
        DEFAULT_UNIFIED_SETTINGS,
        TEST_PROVIDERS,
      )}
      defaultModelSelection={DEFAULT_SELECTION}
      lockedProvider={null}
      onStart={onStart}
    />,
    { container: host },
  );
  return {
    onStart,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("FollowupCustomStartDialog", () => {
  beforeEach(async () => {
    await __resetLocalApiForTests();
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    await __resetLocalApiForTests();
  });

  it("starts a new conversation on the composer's model by default", async () => {
    const mounted = await mountDialog();
    try {
      await page.getByRole("button", { name: "Start", exact: true }).click();

      expect(mounted.onStart).toHaveBeenCalledTimes(1);
      const options = mounted.onStart.mock.calls[0]![1];
      expect(options.target).toBe("newThread");
      expect(options.modelSelection).toEqual(DEFAULT_SELECTION);
    } finally {
      await mounted.cleanup();
    }
  });

  it("can aim the task at the current conversation, which drops the new-thread options", async () => {
    const mounted = await mountDialog();
    try {
      await page.getByRole("radio", { name: /In this conversation/u }).click();

      // "Where" and the handoff checkbox only describe a conversation that is
      // about to be created, so they must not linger once it will not be.
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").not.toContain("handed off");
      });

      await page.getByRole("button", { name: "Start", exact: true }).click();

      const options = mounted.onStart.mock.calls[0]![1];
      expect(options.target).toBe("currentChat");
      expect(options.worktree).toBe(false);
      expect(options.markHandoff).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("hands back the provider and model picked in the dialog", async () => {
    const mounted = await mountDialog();
    try {
      await page.getByRole("button", { name: /GPT-5 Codex/u }).click();
      await page.getByRole("button", { name: "Claude", exact: true }).click();
      await page.getByText("Claude Opus 4.6").click();

      await page.getByRole("button", { name: "Start", exact: true }).click();

      const options = mounted.onStart.mock.calls[0]![1];
      expect(options.modelSelection).toEqual({
        instanceId: CLAUDE_INSTANCE_ID,
        model: "claude-opus-4-6",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("omits the target choice when there is no started conversation to run in", async () => {
    const mounted = await mountDialog({ canRunInCurrentChat: false });
    try {
      expect(document.body.textContent ?? "").not.toContain("In this conversation");
    } finally {
      await mounted.cleanup();
    }
  });
});
