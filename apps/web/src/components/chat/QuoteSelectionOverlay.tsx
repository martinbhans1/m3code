import { TextQuoteIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

interface QuoteButtonPlacement {
  top: number;
  left: number;
  below: boolean;
  text: string;
}

function closestElement(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/**
 * Floating "Quote" pill that appears next to a text selection inside the
 * messages timeline. Clicking it hands the selected text to `onQuote` (which
 * drops it into the composer as a <quote> block) and clears the selection.
 */
export const QuoteSelectionOverlay = memo(function QuoteSelectionOverlay(props: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Returns true when the quote landed in the composer. */
  onQuote: (text: string) => boolean;
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
      if (!closestElement(selection.anchorNode)?.closest("[data-message-id]")) {
        setPlacement(null);
        return;
      }
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
      setPlacement({ top, left, below, text });
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

  return (
    <div
      className="pointer-events-none absolute z-30"
      style={{ top: placement.top, left: placement.left }}
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
          window.getSelection()?.removeAllRanges();
          setPlacement(null);
        }}
        className={cn(
          "pointer-events-auto flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1 text-muted-foreground text-xs shadow-md transition-colors hover:border-border hover:text-foreground hover:cursor-pointer",
          placement.below ? "translate-y-0" : "-translate-y-full",
        )}
      >
        <TextQuoteIcon className="size-3.5" />
        Quote
      </button>
    </div>
  );
});
