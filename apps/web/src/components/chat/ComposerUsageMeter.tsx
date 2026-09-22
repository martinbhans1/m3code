/**
 * The composer's single budget meter: context window *and* plan usage for
 * every configured provider, behind one hover target.
 *
 * These used to be two separate dials in two corners of the footer — one on
 * the provider chip, one next to the send button — which cost twice the
 * horizontal room and still forced two hovers to answer one question ("how
 * much room do I have left?"). They now share a trigger and a popup, and the
 * whole thing floats over the top-right of the input surface instead of
 * competing with the footer controls for space.
 */
import { memo } from "react";
import type { ProviderInstanceId } from "@t3tools/contracts";

import { cn, formatPercentLabel } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import {
  getProviderUsageSummary,
  type ProviderUsageSummary,
  type ProviderUsageWindowPresentation,
} from "../settings/providerStatus";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ProviderUsageBody, USAGE_SEVERITY_COLOR } from "./ProviderUsagePanel";
import { UsageRing } from "./UsageRing";
import type { ProviderInstanceEntry } from "../../providerInstances";

/**
 * How often the meter re-reads the clock. Every label it renders has minute
 * granularity, so a slow tick is enough to keep countdowns and the staleness
 * note honest — and usage arrives by push, so nothing else re-renders this on
 * an idle session.
 */
const USAGE_CLOCK_TICK_MS = 30_000;

interface UsageEntry {
  readonly entry: ProviderInstanceEntry;
  readonly summary: ProviderUsageSummary;
}

const SESSION_WINDOW_IDS = new Set(["five_hour", "primary"]);
const WEEKLY_WINDOW_IDS = new Set(["seven_day", "secondary", "weekly"]);

function findSemanticWindow(
  summary: ProviderUsageSummary | undefined,
  kind: "session" | "weekly",
): ProviderUsageWindowPresentation | undefined {
  if (summary?.kind !== "measured") return undefined;
  const ids = kind === "session" ? SESSION_WINDOW_IDS : WEEKLY_WINDOW_IDS;
  return (
    summary.windows.find((window) => ids.has(window.id)) ??
    summary.windows.find((window) =>
      kind === "session"
        ? /session|5\s*-?\s*h(?:our)?/iu.test(window.label)
        : /week/iu.test(window.label),
    )
  );
}

function usageLayer(window: ProviderUsageWindowPresentation | undefined) {
  return window
    ? {
        percent: window.percent,
        color: USAGE_SEVERITY_COLOR[window.severity],
      }
    : undefined;
}

export const ComposerUsageMeter = memo(function ComposerUsageMeter(props: {
  /** Context window for the active thread; null before the first turn. */
  contextWindow: ContextWindowSnapshot | null;
  /** Provider that owns the context window, for the compaction note. */
  contextProviderDisplayName: string | null;
  /** Same instance list the composer's provider picker renders. */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** Instance the composer currently routes to; its dial leads. */
  activeInstanceId: ProviderInstanceId | null;
  /** Called when the popover opens so the parent can request a throttled pull. */
  onRequestRefresh?: (() => void) | undefined;
  className?: string;
}) {
  const now = useRelativeTimeTick(USAGE_CLOCK_TICK_MS);

  // Only instances with real windows earn a row. A hover popup that lists
  // "No plan usage reported" for every keyless provider is noise; `/usage` is
  // the surface that explains why a provider has nothing to show.
  const measured: UsageEntry[] = props.instanceEntries.flatMap((entry) => {
    const summary = getProviderUsageSummary(entry.snapshot, now);
    if (summary.kind !== "measured" || summary.windows.length === 0) return [];
    return [{ entry, summary }];
  });
  // The active provider answers "can I keep going right now", so it leads.
  measured.sort((a, b) => {
    const aActive = a.entry.instanceId === props.activeInstanceId ? 0 : 1;
    const bActive = b.entry.instanceId === props.activeInstanceId ? 0 : 1;
    return aActive - bActive;
  });

  const activeUsage = measured.find((item) => item.entry.instanceId === props.activeInstanceId);
  const activeSummary = activeUsage?.summary;
  const weeklyWindow = findSemanticWindow(activeSummary, "weekly");
  const sessionWindow = findSemanticWindow(activeSummary, "session");

  const context = props.contextWindow;
  const contextPercent = Math.max(0, Math.min(100, context?.usedPercentage ?? 0));
  const contextPercentLabel = context ? formatPercentLabel(context.usedPercentage) : null;
  const contextColor = contextPercent > 90 ? "var(--color-red-500)" : "var(--color-blue-500)";
  const totalProcessedTokens = context?.totalProcessedTokens ?? null;

  if (!context && measured.length === 0) {
    return null;
  }

  const contextAriaLabel = context
    ? contextPercentLabel && context.maxTokens !== null
      ? `Context window ${contextPercentLabel} used`
      : `Context window ${formatContextWindowTokens(context.usedTokens)} tokens used`
    : null;
  const planAriaLabel = [weeklyWindow, sessionWindow]
    .filter((window): window is ProviderUsageWindowPresentation => window !== undefined)
    .map((window) => `${window.label} ${window.percentLabel ?? "unknown"} used`)
    .join(", ");

  const contextLayer = context
    ? {
        percent: contextPercent,
        color: contextColor,
      }
    : undefined;
  const weeklyLayer = usageLayer(weeklyWindow);
  const sessionLayer = usageLayer(sessionWindow);
  const hasRingLayer = contextLayer || weeklyLayer || sessionLayer;

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) props.onRequestRefresh?.();
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            // Marks the gauge for the composer's first-line notch rule: the
            // meter renders nothing at all when no provider reports usage and
            // no context window exists, and the notch has to vanish with it.
            data-composer-usage-meter="true"
            className={cn(
              // No inner padding: the dial *is* the button, so the gauge gets
              // the whole 28px instead of a ring shrunk inside a bubble.
              "inline-flex size-7 cursor-pointer items-center justify-center rounded-full",
              // The meter floats over the prompt text, so it carries its own
              // surface — a bare ring on top of a long first line is
              // unreadable in both directions. The disc is now exactly the
              // dial's own bounds rather than extra chrome around it.
              "bg-card/80 text-muted-foreground backdrop-blur-sm",
              "outline-none transition-colors hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              props.className,
            )}
            aria-label={
              [contextAriaLabel, planAriaLabel || null].filter(Boolean).join(", ") ||
              "Usage details"
            }
          />
        }
      >
        {hasRingLayer ? (
          <UsageRing weekly={weeklyLayer} session={sessionLayer} context={contextLayer} />
        ) : measured.length > 0 ? (
          <span aria-hidden="true" className="text-[11px] leading-none opacity-60">
            --
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        // Upward, like the meters this replaced: the trigger sits at the top
        // of a composer that lives at the bottom of the window, so opening
        // downward would cover the prompt the user is reading.
        side="top"
        align="end"
        className="w-72 max-w-none p-0"
        viewportClassName="max-h-[60vh] overflow-y-auto"
      >
        <div className="flex flex-col gap-3 p-3">
          {context ? (
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium text-muted-foreground text-xs">Context window</div>
                {context.maxTokens !== null && contextPercentLabel ? (
                  <div className="text-[11px] tabular-nums text-muted-foreground/70">
                    <span>{contextPercentLabel}</span>
                    <span className="mx-1">·</span>
                    <span>
                      {formatContextWindowTokens(context.usedTokens)}/
                      {formatContextWindowTokens(context.maxTokens ?? null)}
                    </span>
                  </div>
                ) : (
                  <div className="text-[11px] tabular-nums text-muted-foreground/70">
                    {formatContextWindowTokens(context.usedTokens)}
                  </div>
                )}
              </div>
              {context.maxTokens !== null ? (
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(contextPercent)}
                  aria-label="Context window usage"
                >
                  <div
                    className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                    style={{ width: `${contextPercent}%`, backgroundColor: contextColor }}
                  />
                </div>
              ) : null}
              {totalProcessedTokens !== null && totalProcessedTokens > 0 ? (
                <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
                  <span className="text-muted-foreground/60">Total processed</span>
                  <span className="font-medium tabular-nums text-muted-foreground/80">
                    {formatContextWindowTokens(totalProcessedTokens)}
                  </span>
                </div>
              ) : null}
              {context.compactsAutomatically ? (
                <div className="text-pretty text-[11px] font-medium text-muted-foreground/70">
                  {props.contextProviderDisplayName ?? "It"} automatically compacts its context when
                  needed.
                </div>
              ) : null}
            </section>
          ) : null}

          {context && measured.length > 0 ? <div className="h-px bg-border/70" /> : null}

          {measured.length > 0 ? (
            <section className="flex flex-col gap-3">
              <div className="font-medium text-muted-foreground text-xs">Plan usage</div>
              {measured.map(({ entry, summary }) => (
                <div key={entry.instanceId} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <ProviderInstanceIcon
                      driverKind={entry.driverKind}
                      displayName={entry.displayName}
                      accentColor={entry.accentColor}
                      className="size-3.5"
                      iconClassName="size-3.5"
                    />
                    <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground/80">
                      {entry.displayName}
                    </span>
                    {summary.kind === "measured" && summary.planLabel ? (
                      <span className="min-w-0 shrink truncate text-[11px] text-muted-foreground/60">
                        {summary.planLabel}
                      </span>
                    ) : null}
                  </div>
                  <ProviderUsageBody summary={summary} />
                </div>
              ))}
            </section>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
