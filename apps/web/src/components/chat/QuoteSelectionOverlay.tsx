import { MessagesSquareIcon, TextQuoteIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

interface QuoteButtonPlacement {
  top: number;
  left: number;
  below: boolean;
  text: string;
  /** The message the selection sits in — the anchor a side thread would hang off. */
  messageId: string | null;
}

function closestElement(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/**
 * Floating pill that appears next to a text selection inside the messages
 * timeline, offering the two things you can do with a highlighted passage:
 * quote it into the main composer, or open a side thread on the message it
 * came from with the passage already quoted in the reply box. The second is
 * how you say "this specific bit" without retyping which bit you meant.
 */
export const QuoteSelectionOverlay = memo(function QuoteSelectionOverlay(props: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Returns true when the quote landed in the composer. */
  onQuote: (text: string) => boolean;
  /**
   * Open a side thread on `messageId` with the selection quoted into its reply
   * box. Omitted where side threads do not apply, which hides the button.
   */
  onReplyInThread?: ((messageId: string, text: string) => boolean) | undefined;
}) {
  const { containerRef } = props;
  const [placement, setPlacement] = useState<QuoteButtonPlacement | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const update = () => {
      frameRef.current = null;
      const container = containerRef.current;
      const selection = window.getSelection();
      if (
        !container ||
        !selection ||
        selection.isCollapsed ||
        selection.rangeCount === 0 ||
        !selection.anchorNode ||
        !selection.focusNode ||
        !container.contains(selection.anchorNode) ||
        !container.contains(selection.focusNode)
      ) {
        setPlacement(null);
        return;
      }
      // Only offer quoting for selections that start inside an actual message row.
      const messageRow = closestElement(selection.anchorNode)?.closest("[data-message-id]");
      if (!messageRow) {
        setPlacement(null);
        return;
      }
      const messageId = messageRow.getAttribute("data-message-id");
      const text = selection.toString();
      if (text.trim().length === 0) {
        setPlacement(null);
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setPlacement(null);
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const left = Math.min(
        Math.max(rect.left - containerRect.left + rect.width / 2, 48),
        Math.max(containerRect.width - 48, 48),
      );
      // Prefer sitting above the selection; flip below when there's no room.
      const topAbove = rect.top - containerRect.top - 6;
      const below = topAbove < 32;
      const top = below
        ? Math.min(rect.bottom - containerRect.top + 6, containerRect.height - 8)
        : topAbove;
      setPlacement({ top, left, below, text, messageId });
    };
    const schedule = () => {
      if (frameRef.current != null) return;
      frameRef.current = window.requestAnimationFrame(update);
    };
    const container = containerRef.current;
    document.addEventListener("selectionchange", schedule);
    window.addEventListener("resize", schedule);
    // Timeline scrolling happens inside a nested virtualized list — capture
    // catches it without knowing which descendant actually scrolls.
    container?.addEventListener("scroll", schedule, { capture: true, passive: true });
    return () => {
      document.removeEventListener("selectionchange", schedule);
      window.removeEventListener("resize", schedule);
      container?.removeEventListener("scroll", schedule, { capture: true });
      if (frameRef.current != null) {
        window.cancelAnimationFrame(frameRef.current);
      }
    };
  }, [containerRef]);

  if (!placement) {
    return null;
  }

  const dismiss = () => {
    window.getSelection()?.removeAllRanges();
    setPlacement(null);
  };
  const anchorMessageId = placement.messageId;
  const canReplyInThread = Boolean(props.onReplyInThread) && anchorMessageId !== null;

  return (
    <div
      className="pointer-events-none absolute z-30"
      style={{ top: placement.top, left: placement.left }}
    >
      <div
        className={cn(
          "pointer-events-auto flex -translate-x-1/2 items-center overflow-hidden rounded-full border border-border/60 bg-card text-muted-foreground text-xs shadow-md",
          placement.below ? "translate-y-0" : "-translate-y-full",
        )}
      >
        <button
          type="button"
          data-quote-selection-button="true"
          // Keep the selection alive: default mousedown behavior would collapse
          // it before click fires.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            // Keep the selection (and the pill) when the composer rejects the
            // insert — e.g. an approval prompt is up or we're disconnected.
            if (!props.onQuote(placement.text)) return;
            dismiss();
          }}
          className="flex items-center gap-1.5 px-3 py-1 transition-colors hover:text-foreground hover:cursor-pointer"
        >
          <TextQuoteIcon className="size-3.5" />
          Quote
        </button>
        {canReplyInThread ? (
          <button
            type="button"
            data-reply-in-thread-button="true"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!anchorMessageId) return;
              if (!props.onReplyInThread?.(anchorMessageId, placement.text)) return;
              dismiss();
            }}
            className="flex items-center gap-1.5 border-border/60 border-l px-3 py-1 transition-colors hover:text-foreground hover:cursor-pointer"
          >
            <MessagesSquareIcon className="size-3.5" />
            Reply in thread
          </button>
        ) : null}
      </div>
    </div>
  );
});
