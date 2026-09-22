/**
 * Rendering for `ServerProvider.usage`, shared by the two surfaces that show
 * it: the hover meter on the composer's provider chip (one provider) and the
 * `/usage` dialog (every configured provider). Both render the same rows, so
 * the rows live here rather than in either caller.
 */
import type { ServerProviderUsageSeverity } from "@t3tools/contracts";

import type {
  ProviderUsagePaceStatus,
  ProviderUsageSummary,
  ProviderUsageWindowPresentation,
} from "../settings/providerStatus";

/**
 * Arc/bar color per severity. Reuses the context-window meter's
 * `blue-500` / `red-500` vocabulary so a full plan window and a full context
 * window read as the same kind of alarm, with an amber tier the
 * context-window meter has no equivalent for.
 */
export const USAGE_SEVERITY_COLOR: Record<ServerProviderUsageSeverity, string> = {
  normal: "var(--color-blue-500)",
  warning: "var(--color-amber-500)",
  critical: "var(--color-red-500)",
};

/** Shown when a window exists but the provider reported no utilization. */
const UNKNOWN_PERCENT_PLACEHOLDER = "--";

/**
 * Colour for the pace verdict. Only a projection that overruns the window
 * earns alarm colour: "on pace for 68%" is good news and must not compete
 * with the bar for attention.
 */
const PACE_STATUS_CLASS: Record<ProviderUsagePaceStatus, string> = {
  comfortable: "text-muted-foreground/60",
  tight: "text-amber-500/90",
  exhausting: "text-red-500/90",
};

function ProviderUsageWindowRow(props: { window: ProviderUsageWindowPresentation }) {
  const { window } = props;
  const clampedPercent = Math.max(0, Math.min(100, window.percent ?? 0));
  const pace = window.percent === null ? null : window.pace;
  const projectedWidth = Math.min(100, pace?.projectedPercent ?? 0);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[11px] leading-4 text-muted-foreground/80">
          {window.label}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums leading-4 text-muted-foreground/70">
          {window.percentLabel ?? UNKNOWN_PERCENT_PLACEHOLDER}
        </span>
      </div>
      {/* No bar when utilization is unknown: a 0%-wide bar would read as
          "nothing used", which is a different and wrong claim. */}
      {window.percent === null ? null : (
        <div
          className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(clampedPercent)}
          aria-label={`${window.label} usage`}
        >
          {/* Ghost extension out to the projected finish. Sits behind the
              real fill so it reads as "where this is heading", never as
              usage that has already happened. */}
          {pace && projectedWidth > clampedPercent ? (
            <div
              className="absolute inset-y-0 left-0 rounded-full opacity-30"
              style={{
                width: `${projectedWidth}%`,
                backgroundColor: USAGE_SEVERITY_COLOR[window.severity],
              }}
            />
          ) : null}
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
            style={{
              width: `${clampedPercent}%`,
              backgroundColor: USAGE_SEVERITY_COLOR[window.severity],
            }}
          />
          {/* The clock: where usage would sit if it were spread evenly across
              the window. Fill left of it means you are burning slower than
              time; right of it means faster. */}
          {pace ? (
            <div
              data-usage-pace-tick={window.id}
              className="absolute inset-y-0 w-px bg-foreground/50"
              style={{ left: `${Math.min(100, Math.max(0, pace.elapsedPercent))}%` }}
              aria-hidden="true"
            />
          ) : null}
        </div>
      )}
      {/* Reset countdown and pace verdict share a line when they fit and wrap
          when they don't — the popup is narrow and the pace sentence is the
          longest string in it. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        {window.resetLabel ? (
          <span className="text-[11px] leading-4 text-muted-foreground/60">
            {window.resetLabel}
          </span>
        ) : (
          <span />
        )}
        {pace ? (
          <span className={`text-right text-[11px] leading-4 ${PACE_STATUS_CLASS[pace.status]}`}>
            {pace.label}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ProviderUsageNote(props: { children: string }) {
  return (
    <div className="text-pretty text-[11px] leading-4 text-muted-foreground/60">
      {props.children}
    </div>
  );
}

/**
 * Body of a usage panel for one provider.
 *
 * Every non-`measured` state renders as a muted note, never as an error:
 * "unknown" is the normal state before the first probe and the permanent
 * state for providers without plan limits, and "unavailable" is a plain fact
 * about an API-key account.
 */
export function ProviderUsageBody(props: { summary: ProviderUsageSummary }) {
  const { summary } = props;

  if (summary.kind === "unknown") {
    return <ProviderUsageNote>No plan usage reported.</ProviderUsageNote>;
  }
  if (summary.kind === "unavailable") {
    return <ProviderUsageNote>{summary.detail}</ProviderUsageNote>;
  }
  if (summary.windows.length === 0) {
    return <ProviderUsageNote>No plan usage reported.</ProviderUsageNote>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      {summary.windows.map((window) => (
        <ProviderUsageWindowRow key={window.id} window={window} />
      ))}
      {summary.staleLabel ? <ProviderUsageNote>{summary.staleLabel}</ProviderUsageNote> : null}
    </div>
  );
}
