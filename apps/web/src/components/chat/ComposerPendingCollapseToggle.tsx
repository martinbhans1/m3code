import { ChevronDownIcon } from "lucide-react";
import { memo, type Ref } from "react";
import { cn } from "~/lib/utils";

interface ComposerPendingCollapseToggleProps {
  isCollapsed: boolean;
  onToggle: () => void;
  /** id of the region this toggle shows/hides */
  controlsId: string;
  /** Accessible label shown when the region is currently expanded. */
  collapseLabel: string;
  /** Accessible label shown when the region is currently collapsed. */
  expandLabel: string;
  className?: string | undefined;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * Shared chevron affordance for the composer's pending question / approval
 * cards. On a phone those cards have no height cap of their own and can eat the
 * whole viewport, leaving no way to scroll back through the conversation the
 * question is about — this lets the user park the card as a one-line bar and
 * bring it back.
 */
export const ComposerPendingCollapseToggle = memo(function ComposerPendingCollapseToggle({
  isCollapsed,
  onToggle,
  controlsId,
  collapseLabel,
  expandLabel,
  className,
  ref,
}: ComposerPendingCollapseToggleProps) {
  return (
    <button
      ref={ref}
      type="button"
      aria-expanded={!isCollapsed}
      aria-controls={controlsId}
      aria-label={isCollapsed ? expandLabel : collapseLabel}
      title={isCollapsed ? expandLabel : collapseLabel}
      // Keep the composer's focus/collapse bookkeeping out of this: the card
      // lives inside the composer surface, so a pointerdown here would
      // otherwise steal focus from the prompt input.
      onPointerDown={(event) => event.preventDefault()}
      onClick={onToggle}
      className={cn(
        "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-transparent bg-transparent text-muted-foreground/70 outline-none transition-colors hover:border-border/50 hover:bg-muted/40 hover:text-foreground focus-visible:border-primary/40 focus-visible:ring-1 focus-visible:ring-primary/25",
        className,
      )}
    >
      <ChevronDownIcon
        aria-hidden
        className={cn(
          "size-4 transition-transform duration-150",
          isCollapsed ? "-rotate-90" : "rotate-0",
        )}
      />
    </button>
  );
});
