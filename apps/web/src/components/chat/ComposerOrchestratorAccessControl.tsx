import type {
  OrchestratorAccessOverride,
  OrchestratorThreadAccess,
  ThreadId,
} from "@t3tools/contracts";
import {
  EyeIcon,
  EyeOffIcon,
  GlobeIcon,
  Share2Icon,
  SlidersHorizontalIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback } from "react";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import {
  orchestratorAccessPatch,
  ORCHESTRATOR_ACCESS_DESCRIPTIONS,
  ORCHESTRATOR_ACCESS_INHERIT,
  ORCHESTRATOR_ACCESS_LABELS,
  ORCHESTRATOR_ACCESS_ORDER,
  ORCHESTRATOR_ACCESS_SHORT_LABELS,
  ORCHESTRATOR_OVERRIDE_DESCRIPTIONS,
  ORCHESTRATOR_OVERRIDE_LABELS,
  ORCHESTRATOR_OVERRIDE_ORDER,
  ORCHESTRATOR_OVERRIDE_SHORT_LABELS,
  resolveOrchestratorAccess,
  type OrchestratorAccessSelection,
} from "../../lib/orchestratorAccess";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ORCHESTRATOR_ACCESS_ICONS: Record<OrchestratorThreadAccess, LucideIcon> = {
  none: EyeOffIcon,
  watch: EyeIcon,
  control: Share2Icon,
};

export const ORCHESTRATOR_OVERRIDE_ICONS: Record<OrchestratorAccessOverride, LucideIcon> = {
  "per-conversation": SlidersHorizontalIcon,
  "read-shared": EyeIcon,
  "read-all": GlobeIcon,
  "control-all": Share2Icon,
};

/**
 * The two settings this control is a view of, plus the writer.
 *
 * Shared by the full and compact composer layouts so both derive the same
 * state. Writes go out as a single-entry patch so this control never carries a
 * stale copy of anyone else's sharing setting — see `orchestratorAccessPatch`.
 */
export function useOrchestratorAccessState(threadId: ThreadId | null) {
  const defaultAccess = useSettings((settings) => settings.defaultOrchestratorThreadAccess);
  const accessMap = useSettings((settings) => settings.orchestratorThreadAccess);
  const accessOverride = useSettings((settings) => settings.orchestratorAccessOverride);
  const { updateSettings } = useUpdateSettings();

  const override = threadId === null ? undefined : accessMap[threadId];

  const setSelection = useCallback(
    (selection: OrchestratorAccessSelection) => {
      if (threadId === null) return;
      updateSettings(orchestratorAccessPatch({ threadId, selection }));
    },
    [threadId, updateSettings],
  );

  const effective = resolveOrchestratorAccess({ override, defaultAccess, accessOverride });

  return {
    defaultAccess,
    override,
    accessOverride,
    effective,
    /**
     * True when the blanket override — not this conversation's own setting — is
     * what decided `effective`. The control still edits the per-conversation
     * value, so without saying this the pill would look like it is lying.
     */
    overridden: accessOverride !== "per-conversation" && effective !== (override ?? defaultAccess),
    /** Label for the "no override" option, naming what the default resolves to. */
    inheritLabel: `Follow default (${ORCHESTRATOR_ACCESS_LABELS[defaultAccess].toLowerCase()})`,
    setSelection,
  };
}

/**
 * What the orchestrator can reach, set from inside the orchestrator's own
 * conversation. Overrides every per-conversation setting at once.
 *
 * This exists because the per-thread control is useless in the situation that
 * actually happens — you are away from your desk, you want the orchestrator to
 * sweep everything you have running, and the one conversation you most wanted
 * followed up was never shared. Reaching each thread individually from a phone
 * is not a real option, and neither is the baseline in Settings, because an
 * explicit per-thread entry beats it. This one beats both, in either direction:
 * it can also clamp a set of shared conversations down to read-only for a
 * hands-off sweep.
 */
export const OrchestratorVisibilityControl = memo(function OrchestratorVisibilityControl() {
  const accessOverride = useSettings((settings) => settings.orchestratorAccessOverride);
  const defaultAccess = useSettings((settings) => settings.defaultOrchestratorThreadAccess);
  const { updateSettings } = useUpdateSettings();
  const Icon = ORCHESTRATOR_OVERRIDE_ICONS[accessOverride];

  // "Per conversation" is the only option whose effect depends on another
  // setting, so it names it rather than leaving the user to go and look.
  const perConversationDetail = `${ORCHESTRATOR_OVERRIDE_DESCRIPTIONS["per-conversation"]} Ones you never set follow your default (${ORCHESTRATOR_ACCESS_LABELS[defaultAccess].toLowerCase()}).`;
  const describe = (override: OrchestratorAccessOverride) =>
    override === "per-conversation"
      ? perConversationDetail
      : ORCHESTRATOR_OVERRIDE_DESCRIPTIONS[override];

  return (
    <Tooltip>
      <Select
        value={accessOverride}
        onValueChange={(value) => {
          if (!value) return;
          updateSettings({ orchestratorAccessOverride: value as OrchestratorAccessOverride });
        }}
      >
        <TooltipTrigger
          render={
            <SelectTrigger
              variant="ghost"
              size="sm"
              className="font-medium"
              aria-label="What this orchestrator can see"
            />
          }
        >
          <Icon className="size-4" />
          <SelectValue>{ORCHESTRATOR_OVERRIDE_SHORT_LABELS[accessOverride]}</SelectValue>
        </TooltipTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {ORCHESTRATOR_OVERRIDE_ORDER.map((override) => {
            const OptionIcon = ORCHESTRATOR_OVERRIDE_ICONS[override];
            return (
              <SelectItem key={override} value={override} className="min-w-72 py-2">
                <div className="grid min-w-0 gap-0.5">
                  <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                    <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    {ORCHESTRATOR_OVERRIDE_LABELS[override]}
                  </span>
                  <span className="text-muted-foreground text-xs leading-4">
                    {describe(override)}
                  </span>
                </div>
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>
      <TooltipPopup side="top">{describe(accessOverride)}</TooltipPopup>
    </Tooltip>
  );
});

export const ComposerOrchestratorAccessControl = memo(
  function ComposerOrchestratorAccessControl(props: { threadId: ThreadId }) {
    const {
      accessOverride,
      defaultAccess,
      override,
      effective,
      overridden,
      inheritLabel,
      setSelection,
    } = useOrchestratorAccessState(props.threadId);
    const Icon = ORCHESTRATOR_ACCESS_ICONS[effective];

    const source = overridden
      ? `forced by the orchestrator's own access control ("${ORCHESTRATOR_OVERRIDE_LABELS[accessOverride]}")`
      : override === undefined
        ? "from your settings default"
        : defaultAccess === override
          ? "set for this conversation, matching your default"
          : "set for this conversation";
    const tooltip = `Orchestrator: ${ORCHESTRATOR_ACCESS_LABELS[effective].toLowerCase()}, ${source}. ${ORCHESTRATOR_ACCESS_DESCRIPTIONS[effective]}`;

    return (
      <Tooltip>
        <Select
          value={override ?? ORCHESTRATOR_ACCESS_INHERIT}
          onValueChange={(value) => {
            if (!value) return;
            setSelection(value as OrchestratorAccessSelection);
          }}
        >
          <TooltipTrigger
            render={
              <SelectTrigger
                variant="ghost"
                size="sm"
                className="font-medium"
                aria-label="Orchestrator access"
              />
            }
          >
            <Icon className="size-4" />
            <SelectValue>{ORCHESTRATOR_ACCESS_SHORT_LABELS[effective]}</SelectValue>
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value={ORCHESTRATOR_ACCESS_INHERIT} className="min-w-64 py-2">
              <div className="grid min-w-0 gap-0.5">
                <span className="font-medium text-foreground">{inheritLabel}</span>
                <span className="text-muted-foreground text-xs leading-4">
                  Track the setting, so changing it later moves this conversation too.
                </span>
              </div>
            </SelectItem>
            {ORCHESTRATOR_ACCESS_ORDER.map((access) => {
              const OptionIcon = ORCHESTRATOR_ACCESS_ICONS[access];
              return (
                <SelectItem key={access} value={access} className="min-w-64 py-2">
                  <div className="grid min-w-0 gap-0.5">
                    <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                      <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      {ORCHESTRATOR_ACCESS_LABELS[access]}
                    </span>
                    <span className="text-muted-foreground text-xs leading-4">
                      {ORCHESTRATOR_ACCESS_DESCRIPTIONS[access]}
                    </span>
                  </div>
                </SelectItem>
              );
            })}
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
    );
  },
);
