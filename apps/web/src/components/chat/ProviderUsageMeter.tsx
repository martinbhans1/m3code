import { memo } from "react";
import type { ServerProvider } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { getProviderUsageSummary } from "../settings/providerStatus";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ProviderUsageBody, USAGE_SEVERITY_COLOR } from "./ProviderUsagePanel";
import { UsageRing } from "./UsageRing";

/**
 * How often the meter re-reads the clock. Every label it renders has
 * minute granularity, so a slow tick is enough to keep countdowns and the
 * staleness note honest.
 */
const USAGE_CLOCK_TICK_MS = 30_000;

/**
 * Plan-usage dial for the composer's active provider, expanding on hover.
 *
 * Deliberately mirrors `ContextWindowMeter`: same ring, same trigger button,
 * same popup geometry, since both answer "how much of a budget is left".
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
  // The clock must come from a ticking hook, not `Date.now()` at render.
  // Usage arrives by push, so on an idle session nothing re-renders this
  // component for minutes — and under React Compiler a render-time
  // `Date.now()` is cached against `props.provider` anyway, which would
  // freeze every countdown and make the staleness note unable to ever fire.
  const now = useRelativeTimeTick(USAGE_CLOCK_TICK_MS);
  const summary = getProviderUsageSummary(props.provider, now);

  if (summary.kind !== "measured" || summary.windows.length === 0) {
    return null;
  }

  const headline = summary.headline;
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
            {/* A ring at 0% draws no arc, so an unknown utilization rendered
                as a ring would be pixel-identical to "nothing used" — the same
                lie the window rows refuse to tell with a 0%-wide bar. Show a
                dash instead. */}
            {headline === null ? (
              <span aria-hidden="true" className="text-[11px] leading-none opacity-60">
                –
              </span>
            ) : (
              <UsageRing
                percent={headline.percent ?? 0}
                color={USAGE_SEVERITY_COLOR[headline.severity]}
              />
            )}
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
