import { describe, expect, it } from "@effect/vitest";

import {
  isOrchestratorAccessOverridden,
  resolveOrchestratorThreadAccess,
} from "./orchestratorAccess.ts";

describe("resolveOrchestratorThreadAccess", () => {
  it("falls back to the baseline only when the conversation has no entry", () => {
    expect(
      resolveOrchestratorThreadAccess({
        perConversation: undefined,
        defaultAccess: "watch",
        override: "per-conversation",
      }),
    ).toBe("watch");
    expect(
      resolveOrchestratorThreadAccess({
        perConversation: "none",
        defaultAccess: "control",
        override: "per-conversation",
      }),
    ).toBe("none");
    expect(
      resolveOrchestratorThreadAccess({
        perConversation: "control",
        defaultAccess: "none",
        override: "per-conversation",
      }),
    ).toBe("control");
  });

  it("opens a conversation the user explicitly closed, which is the point of the override", () => {
    // The baseline cannot do this: an explicit "none" outranks it. Forgetting to
    // share the one thread that mattered is the case the override exists for.
    expect(
      resolveOrchestratorThreadAccess({
        perConversation: "none",
        defaultAccess: "none",
        override: "control-all",
      }),
    ).toBe("control");
    expect(
      resolveOrchestratorThreadAccess({
        perConversation: "none",
        defaultAccess: "none",
        override: "read-all",
      }),
    ).toBe("watch");
  });

  it("caps control at watching under read-all, so a blanket sweep cannot send", () => {
    expect(
      resolveOrchestratorThreadAccess({
        perConversation: "control",
        defaultAccess: "control",
        override: "read-all",
      }),
    ).toBe("watch");
  });

  it("clamps power but not reach under read-shared", () => {
    // Shared conversations drop to read-only...
    expect(
      resolveOrchestratorThreadAccess({
        perConversation: "control",
        defaultAccess: "none",
        override: "read-shared",
      }),
    ).toBe("watch");
    // ...and unshared ones stay invisible rather than becoming readable.
    expect(
      resolveOrchestratorThreadAccess({
        perConversation: "none",
        defaultAccess: "control",
        override: "read-shared",
      }),
    ).toBe("none");
    expect(
      resolveOrchestratorThreadAccess({
        perConversation: undefined,
        defaultAccess: "none",
        override: "read-shared",
      }),
    ).toBe("none");
  });

  it("reports whether an override is doing anything", () => {
    expect(isOrchestratorAccessOverridden("per-conversation")).toBe(false);
    expect(isOrchestratorAccessOverridden("read-shared")).toBe(true);
    expect(isOrchestratorAccessOverridden("read-all")).toBe(true);
    expect(isOrchestratorAccessOverridden("control-all")).toBe(true);
  });
});
