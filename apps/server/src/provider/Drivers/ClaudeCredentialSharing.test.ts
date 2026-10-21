import { ProviderInstanceId, type ServerProviderState } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  findClaudeCredentialSharing,
  formatClaudeCredentialSharingMessage,
  isSameResolvedPath,
  withClaudeCredentialSharing,
  type ClaudeCredentialStoreClaim,
} from "./ClaudeCredentialSharing.ts";

const claim = (input: {
  readonly id: string;
  readonly label: string;
  readonly configDirPath: string;
  readonly credentialsPath?: string;
}): ClaudeCredentialStoreClaim => ({
  instanceId: ProviderInstanceId.make(input.id),
  label: input.label,
  configDirPath: input.configDirPath,
  credentialsPath: input.credentialsPath ?? `${input.configDirPath}\\.credentials.json`,
});

const draft = (input: {
  readonly status: ServerProviderState;
  readonly message?: string;
}): ServerProviderDraft => ({
  displayName: "Claude",
  enabled: true,
  installed: true,
  version: "2.1.306",
  status: input.status,
  auth: { status: "authenticated" },
  checkedAt: "2026-10-21T09:23:00.000Z",
  ...(input.message ? { message: input.message } : {}),
  models: [],
  slashCommands: [],
  skills: [],
});

describe("isSameResolvedPath", () => {
  it("matches Windows paths across case and separator spelling", () => {
    expect(
      isSameResolvedPath(
        String.raw`C:\Users\Martin\.claude\.credentials.json`,
        "c:/users/martin/.claude/.credentials.json",
      ),
    ).toBe(true);
  });

  it("keeps POSIX paths case-sensitive", () => {
    expect(isSameResolvedPath("/home/martin/.claude", "/home/Martin/.claude")).toBe(false);
    expect(isSameResolvedPath("/home/martin/.claude", "/home/martin/.claude")).toBe(true);
  });
});

describe("findClaudeCredentialSharing", () => {
  const personal = claim({
    id: "claude_personal",
    label: "Personal",
    configDirPath: String.raw`C:\Users\Martin\.claude-personal`,
  });

  it("reports nothing when an account's sign-in is its own", () => {
    const work = claim({
      id: "claude_work",
      label: "Work",
      configDirPath: String.raw`C:\Users\Martin\.claude-dj`,
    });

    expect(findClaudeCredentialSharing({ claim: personal, others: [personal, work] })).toBe(
      undefined,
    );
  });

  it("names the sibling instance resolving to the same credentials file", () => {
    // What a symlinked `.credentials.json` looks like once resolved: two
    // config dirs, one file.
    const shared = String.raw`C:\Users\Martin\.claude\.credentials.json`;
    const personalShared = { ...personal, credentialsPath: shared };
    const desktop = claim({
      id: "claude_desktop",
      label: "Claude Max 20x",
      configDirPath: String.raw`C:\Users\Martin\.claude`,
      credentialsPath: shared,
    });

    const sharing = findClaudeCredentialSharing({
      claim: personalShared,
      others: [personalShared, desktop],
    });

    expect(sharing?.sharedWith).toEqual(["Claude Max 20x"]);
    expect(formatClaudeCredentialSharingMessage(sharing!)).toContain('"Claude Max 20x"');
  });

  it("reports a store outside the config dir even when no sibling is configured", () => {
    // The case that actually bites: the peer is Claude Desktop or a plain
    // `claude` CLI, which this app does not manage and cannot enumerate.
    const foreign = String.raw`C:\Users\Martin\.claude\.credentials.json`;
    const sharing = findClaudeCredentialSharing({
      claim: { ...personal, credentialsPath: foreign },
      others: [{ ...personal, credentialsPath: foreign }],
    });

    expect(sharing?.sharedWith).toEqual([]);
    expect(sharing?.storePathOutsideConfigDir).toBe(foreign);
    expect(formatClaudeCredentialSharingMessage(sharing!)).toContain(foreign);
  });

  it("accepts a config dir that is itself a symlink, since nothing is shared", () => {
    // Both paths resolve through the same link, so the file still belongs to
    // the dir that reads it.
    const resolved = String.raw`D:\claude-dirs\personal`;
    const sharing = findClaudeCredentialSharing({
      claim: {
        ...personal,
        configDirPath: resolved,
        credentialsPath: `${resolved}\\.credentials.json`,
      },
      others: [personal],
    });

    expect(sharing).toBe(undefined);
  });
});

describe("withClaudeCredentialSharing", () => {
  const sharing = findClaudeCredentialSharing({
    claim: claim({
      id: "claude_personal",
      label: "Personal",
      configDirPath: String.raw`C:\Users\Martin\.claude-personal`,
      credentialsPath: String.raw`C:\Users\Martin\.claude\.credentials.json`,
    }),
    others: [
      claim({
        id: "claude_desktop",
        label: "Desktop",
        configDirPath: String.raw`C:\Users\Martin\.claude`,
      }),
    ],
  });

  it("warns a healthy instance without touching anything else", () => {
    const warned = withClaudeCredentialSharing(draft({ status: "ready" }), sharing);

    expect(warned.status).toBe("warning");
    // A named sibling beats the generic "somewhere outside this folder"
    // wording: the user can act on a name.
    expect(warned.message).toContain('shares one Claude sign-in with "Desktop"');
    expect(warned.version).toBe("2.1.306");
  });

  it("leaves a failing probe on error and lets its own message lead", () => {
    const warned = withClaudeCredentialSharing(
      draft({ status: "error", message: "Claude is signed out." }),
      sharing,
    );

    expect(warned.status).toBe("error");
    expect(warned.message?.startsWith("Claude is signed out. ")).toBe(true);
    expect(warned.message).toContain("cancels the old one");
  });

  it("leaves a disabled instance alone", () => {
    const disabled = draft({ status: "disabled", message: "Claude is disabled." });

    expect(withClaudeCredentialSharing(disabled, sharing)).toBe(disabled);
  });

  it("is a no-op when nothing is shared", () => {
    const healthy = draft({ status: "ready" });

    expect(withClaudeCredentialSharing(healthy, undefined)).toBe(healthy);
  });
});
