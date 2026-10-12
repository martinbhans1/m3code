import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "../ui/button";

/** Find-in-conversation input, floated over the top-right of the timeline. */
export function TimelineFindBar(props: {
  query: string;
  onQueryChange: (query: string) => void;
  currentIndex: number;
  matchCount: number;
  onStep: (direction: 1 | -1) => void;
  onClose: () => void;
  /** Bumped each time the shortcut fires, so a second press re-selects the query. */
  focusRequest: number;
}) {
  const { query, onQueryChange, currentIndex, matchCount, onStep, onClose, focusRequest } = props;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  const hasQuery = query.trim().length > 0;
  const status = !hasQuery
    ? null
    : matchCount === 0
      ? "No results"
      : `${currentIndex + 1} of ${matchCount}`;

  return (
    <div
      role="search"
      className="pointer-events-auto flex items-center gap-1 rounded-lg border border-border/70 bg-background/95 py-1 pr-1 pl-2.5 shadow-md backdrop-blur"
    >
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        type="text"
        aria-label="Find in conversation"
        placeholder="Find in conversation"
        className="w-44 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      />
      {status ? (
        <span
          className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground"
          aria-live="polite"
        >
          {status}
        </span>
      ) : null}
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={matchCount === 0}
        onClick={() => onStep(-1)}
      >
        <ChevronUpIcon className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={matchCount === 0}
        onClick={() => onStep(1)}
      >
        <ChevronDownIcon className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Close find"
        title="Close (Esc)"
        onClick={onClose}
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}
