import { memo } from "react";
import type { ServerProvider } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { getProviderUsageSummary } from "../settings/providerStatus";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ProviderUsageBody, USAGE_SEVERITY_COLOR } from "./ProviderUsagePanel";
import { UsageRing } from "./UsageRing";

/**
 * Plan-usage dial for the composer's active provider, expanding on hover.
 *
 * Deliberately mirrors `ContextWindowMeter`: same ring, same trigger button,
 * same popup geometry. The two sit next to each other in the composer footer
 * and answer the same shape of question ("how much of a budget is left"), so
 * they are built from the same parts.
 *
 * Renders nothing unless there are real windows to show. Absent usage is the
 * normal state for the first seconds after boot and forever for providers
 * with no plan limits (cursor, opencode, grok); a permanently dashed dial on
 * those would be noise. `/usage` is the surface that explains *why* a
 * provider has no dial.
 */
export const ProviderUsageMeter = memo(function ProviderUsageMeter(props: {
  /** Snapshot for the instance the composer currently routes to. */
  provider: ServerProvider | undefined;
  /** Instance display name, used to disambiguate the meter's aria-label. */
  displayName: string;
}) {
  // Read the clock at render rather than on a timer: plan windows move on the
  // order of minutes, and the snapshot re-renders this component whenever the
  // numbers actually change, so a ticking interval would burn frames to
  // remove drift nobody can see.
  const summary = getProviderUsageSummary(props.provider, Date.now());

  if (summary.kind !== "measured" || summary.windows.length === 0) {
    return null;
  }

  const headline = summary.headline;
  const ringColor =
    headline === null
      ? "color-mix(in oklab, var(--color-muted-foreground) 55%, transparent)"
      : USAGE_SEVERITY_COLOR[summary.severity];
  const usageLabel = headline
    ? `${headline.percentLabel ?? "unknown"} of ${headline.label} used`
    : "utilization unknown";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "inline-flex size-6 cursor-pointer items-center justify-center rounded-full border border-transparent text-muted-foreground outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
            aria-label={`${props.displayName} plan usage: ${usageLabel}`}
          >
            <UsageRing percent={headline?.percent ?? 0} color={ringColor} />
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-64 max-w-none p-0">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Plan usage</div>
            {summary.planLabel ? (
              <div className="min-w-0 truncate text-[11px] text-muted-foreground/70">
                {summary.planLabel}
              </div>
            ) : null}
          </div>
          <ProviderUsageBody summary={summary} />
        </div>
      </PopoverPopup>
    </Popover>
  );
});
