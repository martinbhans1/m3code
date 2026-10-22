import {
  OrchestrationDispatchCommandError,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  classifyBootstrapFailure,
  formatMultiModelTriggerLabel,
  resolveMultiModelLabels,
  resolveMultiModelSendBlockReason,
  resolveMultiModelTargets,
  resolveMultiModelTitleSuffixes,
  resolveSelectionsToRestore,
  startMultiModelThreads,
  toggleMultiModelSelection,
} from "./multiModelSend";

const claudeA = ProviderInstanceId.make("claude_a");
const claudeB = ProviderInstanceId.make("claude_b");
const codex = ProviderInstanceId.make("codex");

const pick = (instanceId: ProviderInstanceId, model: string): ModelSelection => ({
  instanceId,
  model,
});

function entry(
  instanceId: ProviderInstanceId,
  displayName: string,
  overrides: Partial<ProviderInstanceEntry> = {},
): ProviderInstanceEntry {
  return {
    instanceId,
    driverKind: ProviderDriverKind.make(instanceId === codex ? "codex" : "claudeAgent"),
    displayName,
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: false,
    isAvailable: true,
    snapshot: {} as ServerProvider,
    models: [
      { slug: "opus", name: "Claude Opus", shortName: "Opus", isCustom: false, capabilities: null },
      { slug: "sonnet", name: "Claude Sonnet", isCustom: false, capabilities: null },
    ],
    ...overrides,
  };
}

const entries = [entry(claudeA, "Claude A"), entry(claudeB, "Claude B"), entry(codex, "Codex")];

describe("toggleMultiModelSelection", () => {
  const primary = pick(claudeA, "opus");

  it("starts a multi-selection from the composer's model plus the shift-clicked one", () => {
    const result = toggleMultiModelSelection({
      current: null,
      primary,
      toggled: pick(claudeB, "opus"),
    });
    expect(result.multi).toEqual([primary, pick(claudeB, "opus")]);
  });

  it("treats the same model on another instance as a separate pick", () => {
    const result = toggleMultiModelSelection({
      current: [primary, pick(claudeB, "opus")],
      primary,
      toggled: pick(codex, "opus"),
    });
    expect(result.multi).toHaveLength(3);
  });

  it("removes a pick that is already selected", () => {
    const result = toggleMultiModelSelection({
      current: [primary, pick(claudeB, "opus"), pick(codex, "gpt")],
      primary,
      toggled: pick(claudeB, "opus"),
    });
    expect(result.multi).toEqual([primary, pick(codex, "gpt")]);
  });

  it("collapses to single-select on the remaining pick when one is left", () => {
    const result = toggleMultiModelSelection({
      current: [primary, pick(claudeB, "opus")],
      primary,
      toggled: primary,
    });
    expect(result.multi).toBeNull();
    expect(result.single).toEqual(pick(claudeB, "opus"));
  });

  it("shift-clicking the only model is a no-op in single-select", () => {
    const result = toggleMultiModelSelection({ current: null, primary, toggled: primary });
    expect(result).toEqual({ multi: null, single: primary });
  });

  it("carries the traits passed for the added pick", () => {
    const options = [{ id: "effort", value: "high" }] as const;
    const result = toggleMultiModelSelection({
      current: null,
      primary,
      toggled: pick(claudeB, "opus"),
      options,
    });
    expect(result.multi?.[1]?.options).toEqual(options);
  });
});

describe("trigger labels", () => {
  it("names picks by model, and by account when two share a model", () => {
    const labels = resolveMultiModelLabels(
      [pick(claudeA, "opus"), pick(claudeB, "opus"), pick(codex, "gpt")],
      {
        modelName: (selection) => (selection.model === "opus" ? "Opus" : "GPT"),
        instanceName: (selection) =>
          entries.find((candidate) => candidate.instanceId === selection.instanceId)!.displayName,
      },
    );
    expect(labels).toEqual(["Claude A", "Claude B", "GPT"]);
  });

  it("shows two names and counts the rest", () => {
    expect(formatMultiModelTriggerLabel(["A", "B"])).toBe("A, B");
    expect(formatMultiModelTriggerLabel(["A", "B", "C", "D"])).toBe("A, B, +2");
  });
});

describe("resolveMultiModelSendBlockReason", () => {
  it("requires a git project and a base branch", () => {
    expect(
      resolveMultiModelSendBlockReason({ isGitRepo: false, baseBranch: "main", projectCwd: "/p" }),
    ).not.toBeNull();
    expect(
      resolveMultiModelSendBlockReason({ isGitRepo: true, baseBranch: null, projectCwd: "/p" }),
    ).not.toBeNull();
    expect(
      resolveMultiModelSendBlockReason({ isGitRepo: true, baseBranch: "main", projectCwd: "/p" }),
    ).toBeNull();
  });
});

describe("resolveMultiModelTargets", () => {
  it("suffixes each title with the account, adding the model when an account repeats", () => {
    expect(
      resolveMultiModelTitleSuffixes(
        [pick(claudeA, "opus"), pick(claudeA, "sonnet"), pick(codex, "opus")],
        entries,
      ),
    ).toEqual(["Claude A Opus", "Claude A Claude Sonnet", "Codex"]);

    const resolved = resolveMultiModelTargets({
      selections: [pick(claudeA, "opus"), pick(claudeB, "opus")],
      entries,
      titleSeed: "Fix login",
    });
    expect(resolved.ok && resolved.targets.map((target) => target.title)).toEqual([
      "Fix login · Claude A",
      "Fix login · Claude B",
    ]);
  });

  it("rejects a pick whose instance was removed", () => {
    const resolved = resolveMultiModelTargets({
      selections: [pick(claudeA, "opus"), pick(ProviderInstanceId.make("gone"), "opus")],
      entries,
      titleSeed: "x",
    });
    expect(resolved.ok).toBe(false);
  });

  it("rejects a pick whose instance is disabled or not ready", () => {
    for (const broken of [
      entry(claudeB, "Claude B", { enabled: false }),
      entry(claudeB, "Claude B", { status: "error" }),
      entry(claudeB, "Claude B", { isAvailable: false }),
    ]) {
      const resolved = resolveMultiModelTargets({
        selections: [pick(claudeA, "opus"), pick(claudeB, "opus")],
        entries: [entries[0]!, broken],
        titleSeed: "x",
      });
      expect(resolved).toMatchObject({ ok: false });
    }
  });
});

describe("classifyBootstrapFailure", () => {
  it("trusts a server rejection to have left nothing behind", () => {
    expect(
      classifyBootstrapFailure(
        new OrchestrationDispatchCommandError({ message: "Failed to create worktree." }),
      ),
    ).toBe("not-started");
  });

  it("treats transport failures and duplicate-id rejections as possibly started", () => {
    expect(classifyBootstrapFailure(new Error("WebSocket connection closed"))).toBe("uncertain");
    expect(
      classifyBootstrapFailure(
        new OrchestrationDispatchCommandError({
          message: "Thread 't1' already exists and cannot be created twice.",
        }),
      ),
    ).toBe("uncertain");
  });
});

describe("startMultiModelThreads", () => {
  const targets = [
    { selection: pick(claudeA, "opus") },
    { selection: pick(claudeB, "opus") },
    { selection: pick(codex, "gpt") },
  ];

  it("starts one at a time, each under a fresh thread id", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let counter = 0;
    const seen: string[] = [];
    const results = await startMultiModelThreads({
      targets,
      newThreadId: () => ThreadId.make(`t${++counter}`),
      start: async (_target, threadId) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        seen.push(threadId);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
      },
    });
    expect(maxInFlight).toBe(1);
    expect(new Set(seen).size).toBe(3);
    expect(results.every((result) => result.status === "started")).toBe(true);
  });

  it("keeps going past a failure and restores only definite failures", async () => {
    let counter = 0;
    const results = await startMultiModelThreads({
      targets,
      newThreadId: () => ThreadId.make(`t${++counter}`),
      start: async (target) => {
        if (target.selection.instanceId === claudeA) {
          throw new OrchestrationDispatchCommandError({ message: "worktree failed" });
        }
        if (target.selection.instanceId === claudeB) {
          throw new Error("socket closed");
        }
      },
    });
    expect(results.map((result) => result.status)).toEqual(["not-started", "uncertain", "started"]);
    expect(results[1]?.threadId).toBe("t2");
    expect(resolveSelectionsToRestore(results)).toEqual([pick(claudeA, "opus")]);
  });
});
