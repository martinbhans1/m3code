/** One semantic layer in the composer's concentric budget gauge. */
export interface UsageRingLayer {
  /** `0`-`100`; null means the provider exposed the window but not its usage. */
  readonly percent: number | null;
  readonly color: string;
}

const RINGS = [
  { key: "weekly", radius: 10.25, strokeWidth: 2 },
  { key: "session", radius: 7, strokeWidth: 2 },
  { key: "context", radius: 3.75, strokeWidth: 2 },
] as const;

/**
 * One compact gauge with stable semantics from outside to inside:
 * weekly plan limit, session plan limit, then conversation context window.
 */
export function UsageRing(props: {
  readonly weekly?: UsageRingLayer | undefined;
  readonly session?: UsageRingLayer | undefined;
  readonly context?: UsageRingLayer | undefined;
}) {
  return (
    <span className="relative flex size-full items-center justify-center">
      <svg
        viewBox="0 0 24 24"
        className="-rotate-90 absolute inset-0 size-full transform-gpu"
        aria-hidden="true"
        data-testid="concentric-usage-ring"
      >
        {RINGS.map(({ key, radius, strokeWidth }) => {
          const layer = props[key];
          if (!layer) return null;

          const circumference = 2 * Math.PI * radius;
          const clampedPercent = Math.max(0, Math.min(100, layer.percent ?? 0));
          const dashOffset = circumference - (clampedPercent / 100) * circumference;

          return (
            <g key={key} data-usage-ring-layer={key}>
              <circle
                cx="12"
                cy="12"
                r={radius}
                fill="none"
                stroke="color-mix(in oklab, var(--color-muted-foreground) 35%, transparent)"
                strokeWidth={strokeWidth}
                strokeDasharray={layer.percent === null ? "1 2" : undefined}
              />
              {layer.percent !== null ? (
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={layer.color}
                  strokeWidth={strokeWidth}
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                />
              ) : null}
            </g>
          );
        })}
      </svg>
    </span>
  );
}
