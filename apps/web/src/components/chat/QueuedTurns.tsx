import { useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import type { QueuedTurn } from "~/queuedTurnStore";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";

/**
 * A single queued message waiting for the current turn to finish.
 *
 * Queuing is entirely client-side: pressing Enter while the agent is running
 * parks the turn here instead of dispatching it. That makes a queued card the
 * last point where the text is still recoverable, so it has to expand (the
 * one-line truncation hid long prompts with no way to read or select them),
 * copy, and promote to a steer — Enter is easy to hit by accident when the
 * intent was to interrupt.
 */
function QueuedTurnRow(props: {
  readonly turn: QueuedTurn;
  readonly index: number;
  readonly count: number;
  readonly onMove: (id: string, offset: -1 | 1) => void;
  readonly onRemove: (id: string) => void;
  readonly onRetry: (id: string) => void;
  readonly onSendNow: (id: string) => void;
}) {
  const { count, index, turn } = props;
  const [expanded, setExpanded] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const text = turn.displayText || "Attachment";
  const isPending = turn.status === "queued";

  return (
    <div className="flex flex-col rounded-xl border border-border bg-card/95 px-3 py-2 text-sm shadow-sm">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs font-medium text-muted-foreground">
          {turn.status === "sending"
            ? "Sending…"
            : turn.status === "failed"
              ? "Send failed"
              : "Queued"}
        </span>
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse queued message" : "Expand queued message"}
        >
          {expanded ? (
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">{text}</span>
        </button>
        {turn.error ? <span className="sr-only">{turn.error}</span> : null}
        {isPending ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="shrink-0 rounded-full"
            onClick={() => props.onSendNow(turn.id)}
            title="Send this to the agent now instead of waiting for the current turn to finish"
          >
            Steer
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={() => copyToClipboard(text)}
          aria-label="Copy queued message"
          title="Copy queued message"
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
        </Button>
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
        {/*
         * Reordering only makes sense with more than one queued message. Showing
         * a pair of disabled up/down chevrons on a lone card made it read as the
         * timeline's previous/next prompt navigator, which it is not.
         */}
        {count > 1 ? (
          <>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              disabled={index === 0 || !isPending}
              onClick={() => props.onMove(turn.id, -1)}
              aria-label="Move queued message up"
            >
              <ArrowUpIcon />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              disabled={index === count - 1 || !isPending}
              onClick={() => props.onMove(turn.id, 1)}
              aria-label="Move queued message down"
            >
              <ArrowDownIcon />
            </Button>
          </>
        ) : null}
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
      {expanded ? (
        <div className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-t border-border/60 pt-2 text-sm text-foreground/90 select-text">
          {text}
        </div>
      ) : null}
      {turn.error ? (
        <div className="mt-1 text-xs text-destructive" aria-hidden="true">
          {turn.error}
        </div>
      ) : null}
    </div>
  );
}

export function QueuedTurns(props: {
  readonly turns: ReadonlyArray<QueuedTurn>;
  readonly onMove: (id: string, offset: -1 | 1) => void;
  readonly onRemove: (id: string) => void;
  readonly onRetry: (id: string) => void;
  readonly onSendNow: (id: string) => void;
}) {
  if (props.turns.length === 0) return null;

  return (
    <div
      className="mx-auto mb-2 flex w-full max-w-208 flex-col gap-1.5"
      aria-label="Queued messages"
    >
      {props.turns.map((turn, index) => (
        <QueuedTurnRow
          key={turn.id}
          turn={turn}
          index={index}
          count={props.turns.length}
          onMove={props.onMove}
          onRemove={props.onRemove}
          onRetry={props.onRetry}
          onSendNow={props.onSendNow}
        />
      ))}
    </div>
  );
}
