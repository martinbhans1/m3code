import type {
  OrchestratorAccessOverride,
  OrchestratorThreadAccess,
  ThreadId,
} from "@t3tools/contracts";
import { resolveOrchestratorThreadAccess } from "@t3tools/shared/orchestratorAccess";

/**
 * Presentation for the orchestrator's per-conversation access setting, shared
 * by the composer control, the sidebar context menu and the settings panel so
 * the three never drift into describing the same value differently.
 */

export const ORCHESTRATOR_ACCESS_ORDER = [
  "none",
  "watch",
  "control",
] as const satisfies ReadonlyArray<OrchestratorThreadAccess>;

/** Full labels, for menus and settings where there is room. */
export const ORCHESTRATOR_ACCESS_LABELS: Record<OrchestratorThreadAccess, string> = {
  none: "Not shared",
  watch: "Watch",
  control: "Watch and control",
};

/** Terse labels, for the composer footer where there is not. */
export const ORCHESTRATOR_ACCESS_SHORT_LABELS: Record<OrchestratorThreadAccess, string> = {
  none: "Hidden",
  watch: "Watch",
  control: "Control",
};

export const ORCHESTRATOR_ACCESS_DESCRIPTIONS: Record<OrchestratorThreadAccess, string> = {
  none: "The orchestrator cannot see this conversation at all.",
  watch: "The orchestrator can read this conversation, but not send to it.",
  control: "The orchestrator can read this conversation and start turns in it.",
};

/**
 * The blanket override, seen from the orchestrator's own conversation, where
 * the question is "how much can you see" rather than "how much of this thread
 * is shared".
 *
 * Phrased for the person about to hand over everything they have running,
 * usually from a phone, usually because they suspect they forgot to share
 * something and cannot go check thread by thread.
 */
export const ORCHESTRATOR_OVERRIDE_ORDER = [
  "per-conversation",
  "read-shared",
  "read-all",
  "control-all",
] as const satisfies ReadonlyArray<OrchestratorAccessOverride>;

export const ORCHESTRATOR_OVERRIDE_LABELS: Record<OrchestratorAccessOverride, string> = {
  "per-conversation": "Per conversation",
  "read-shared": "Shared, read-only",
  "read-all": "Read everything",
  "control-all": "Read and steer everything",
};

/** Terse labels, for the composer footer where there is no room for the above. */
export const ORCHESTRATOR_OVERRIDE_SHORT_LABELS: Record<OrchestratorAccessOverride, string> = {
  "per-conversation": "Per conversation",
  "read-shared": "Read shared",
  "read-all": "Read all",
  "control-all": "Control all",
};

export const ORCHESTRATOR_OVERRIDE_DESCRIPTIONS: Record<OrchestratorAccessOverride, string> = {
  "per-conversation":
    "Each conversation's own setting decides what the orchestrator can do with it.",
  "read-shared": "Everything you have shared becomes readable but unsendable, however you set it.",
  "read-all": "Every conversation is readable, shared or not — but none can be sent to.",
  // Says what it grants rather than what it is for: this one also lets the
  // orchestrator start turns anywhere and close out follow-ups.
  "control-all":
    "Every conversation can be read, sent to, and have its follow-ups closed — across all projects, whatever each one is set to.",
};

/**
 * Sentinel for the select: no per-conversation entry at all, so the thread
 * follows `defaultOrchestratorThreadAccess`. Distinct from an explicit "none",
 * which holds a conversation closed even when the default is open.
 */
export const ORCHESTRATOR_ACCESS_INHERIT = "inherit" as const;

export type OrchestratorAccessSelection =
  | OrchestratorThreadAccess
  | typeof ORCHESTRATOR_ACCESS_INHERIT;

/**
 * What the orchestrator may actually do with one conversation.
 *
 * Delegates to the shared resolver the MCP handlers enforce with, rather than
 * restating the precedence: the board and the composer pill claiming access the
 * server then refuses is the exact confusion this feature exists to remove.
 */
export function resolveOrchestratorAccess(input: {
  /** This conversation's own entry, or undefined when it has none. */
  readonly override: OrchestratorThreadAccess | undefined;
  readonly defaultAccess: OrchestratorThreadAccess;
  /** The orchestrator's blanket override, which wins over both of the above. */
  readonly accessOverride: OrchestratorAccessOverride;
}): OrchestratorThreadAccess {
  return resolveOrchestratorThreadAccess({
    perConversation: input.override,
    defaultAccess: input.defaultAccess,
    override: input.accessOverride,
  });
}

/**
 * Build the settings patch for one conversation's selection.
 *
 * Deliberately a single-entry patch rather than a rewritten map: the map is
 * also written by the sidebar, by other clients and by the orchestrator itself,
 * and a whole-map write carries a possibly-stale copy of every *other* thread's
 * setting, which can silently restore access the user just revoked elsewhere.
 * "Follow the default" is a deletion rather than a value, so the thread keeps
 * tracking the setting when the user later changes it.
 */
export function orchestratorAccessPatch(input: {
  readonly threadId: ThreadId;
  readonly selection: OrchestratorAccessSelection;
}): {
  orchestratorThreadAccessEntry: {
    threadId: ThreadId;
    access: OrchestratorThreadAccess | null;
  };
} {
  return {
    orchestratorThreadAccessEntry: {
      threadId: input.threadId,
      access: input.selection === ORCHESTRATOR_ACCESS_INHERIT ? null : input.selection,
    },
  };
}
