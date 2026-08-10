import type { OrchestratorAccessOverride, OrchestratorThreadAccess } from "@t3tools/contracts";

/**
 * How much of one conversation the orchestrator may touch, given every setting
 * that has a say.
 *
 * Three settings stack, narrowest to widest: the conversation's own entry, the
 * baseline for conversations without one, and the blanket override the user
 * sets from the orchestrator's own composer. The override is deliberately
 * authoritative — the case it exists for is "I forgot to share the one thread I
 * actually cared about", which a setting that merely fills in the gaps could
 * not fix.
 *
 * Shared by the MCP handlers (what the orchestrator is actually allowed to do)
 * and by the web client (what the board and the composer pill say it can do),
 * because those disagreeing is the failure this whole feature is about.
 */
export function resolveOrchestratorThreadAccess(input: {
  /** The conversation's own entry, or undefined when it has none. */
  readonly perConversation: OrchestratorThreadAccess | undefined;
  /** Baseline for conversations with no entry of their own. */
  readonly defaultAccess: OrchestratorThreadAccess;
  readonly override: OrchestratorAccessOverride;
}): OrchestratorThreadAccess {
  const configured = input.perConversation ?? input.defaultAccess;
  switch (input.override) {
    case "control-all":
      return "control";
    case "read-all":
      return "watch";
    // Reach unchanged, power clamped: conversations that were never shared stay
    // invisible, and the ones that were become read-only however they were set.
    case "read-shared":
      return configured === "none" ? "none" : "watch";
    case "per-conversation":
      return configured;
  }
}

/** Whether an override is doing anything, for wording that says so. */
export const isOrchestratorAccessOverridden = (override: OrchestratorAccessOverride): boolean =>
  override !== "per-conversation";
