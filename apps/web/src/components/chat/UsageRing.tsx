/**
 * Compact circular gauge used by the composer's meters.
 *
 * Extracted from `ContextWindowMeter` when the provider plan-usage meter
 * grew the same dial: both render a single stroked arc at the same size next
 * to the composer controls, and they must stay pixel-identical so two meters
 * sitting side by side read as one control surface rather than two.
 */
export function UsageRing(props: {
  /** `0`–`100`. Clamped, so callers may pass raw provider percentages. */
  percent: number;
  /** Arc color. A CSS color or `var(--…)` reference. */
  color: string;
}) {
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const clampedPercent = Math.max(0, Math.min(100, props.percent));
  const dashOffset = circumference - (clampedPercent / 100) * circumference;

  return (
    <span className="relative flex size-4 items-center justify-center">
      <svg
        viewBox="0 0 24 24"
        className="-rotate-90 absolute inset-0 size-full transform-gpu"
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke="color-mix(in oklab, var(--color-muted-foreground) 35%, transparent)"
          strokeWidth="3"
        />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke={props.color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
        />
      </svg>
    </span>
  );
}
