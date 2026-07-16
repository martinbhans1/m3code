import { ArrowDownIcon, ArrowUpIcon, RotateCcwIcon, XIcon } from "lucide-react";
import type { QueuedTurn } from "~/queuedTurnStore";
import { Button } from "../ui/button";

export function QueuedTurns(props: {
  readonly turns: ReadonlyArray<QueuedTurn>;
  readonly onMove: (id: string, offset: -1 | 1) => void;
  readonly onRemove: (id: string) => void;
  readonly onRetry: (id: string) => void;
}) {
  if (props.turns.length === 0) return null;

  return (
    <div
      className="mx-auto mb-2 flex w-full max-w-208 flex-col gap-1.5"
      aria-label="Queued messages"
    >
      {props.turns.map((turn, index) => (
        <div
          key={turn.id}
          className="flex items-center gap-2 rounded-xl border border-border bg-card/95 px-3 py-2 text-sm shadow-sm"
        >
          <span className="shrink-0 text-xs font-medium text-muted-foreground">
            {turn.status === "sending"
              ? "Sending…"
              : turn.status === "failed"
                ? "Send failed"
                : "Queued"}
          </span>
          <span className="min-w-0 flex-1 truncate" title={turn.displayText}>
            {turn.displayText || "Attachment"}
          </span>
          {turn.error ? <span className="sr-only">{turn.error}</span> : null}
          {turn.status === "failed" ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              onClick={() => props.onRetry(turn.id)}
              aria-label="Retry queued message"
              title={turn.error ?? "Retry queued message"}
            >
              <RotateCcwIcon />
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={index === 0 || turn.status !== "queued"}
            onClick={() => props.onMove(turn.id, -1)}
            aria-label="Move queued message up"
          >
            <ArrowUpIcon />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={index === props.turns.length - 1 || turn.status !== "queued"}
            onClick={() => props.onMove(turn.id, 1)}
            aria-label="Move queued message down"
          >
            <ArrowDownIcon />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={turn.status === "sending"}
            onClick={() => props.onRemove(turn.id)}
            aria-label="Delete queued message"
          >
            <XIcon />
          </Button>
        </div>
      ))}
    </div>
  );
}
