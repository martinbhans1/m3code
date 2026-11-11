import type { ScopedThreadRef } from "@t3tools/contracts";
import { THREAD_GOAL_MAX_LENGTH } from "@t3tools/shared/threadTags";
import { CheckCircle2Icon, CircleIcon, FlagIcon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { cn } from "../../lib/utils";
import { selectSidebarThreadSummaryByRef, selectThreadByRef, useStore } from "../../store";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * One line above the conversation: what finished looks like, and whether the
 * user has called it finished.
 *
 * The agent writes the goal once, from the opening message; after that it is
 * the user's, edited in place here. Click the text to edit, Enter to save,
 * Escape to cancel. The completed toggle is the same "mark completed" the
 * sidebar offers, so a conversation can be closed without leaving it.
 */
export const ThreadGoalBar = memo(function ThreadGoalBar({
  threadRef,
}: {
  threadRef: ScopedThreadRef;
}) {
  const goal = useStore((state) => selectThreadByRef(state, threadRef)?.goal ?? null);
  const doneAt = useStore((state) => selectSidebarThreadSummaryByRef(state, threadRef)?.doneAt);
  const { setThreadGoal, setThreadDone } = useThreadActions();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goal ?? "");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isCompleted = doneAt !== null && doneAt !== undefined;

  useEffect(() => {
    if (!editing) setDraft(goal ?? "");
  }, [editing, goal]);

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    const next = draft.trim().slice(0, THREAD_GOAL_MAX_LENGTH);
    const nextGoal = next.length > 0 ? next : null;
    if (nextGoal !== goal) void setThreadGoal(threadRef, nextGoal);
  }, [draft, goal, setThreadGoal, threadRef]);

  return (
    <div
      data-testid="thread-goal-bar"
      className="flex items-start gap-2 border-border/60 border-b px-3 py-1.5 text-xs sm:px-5"
    >
      <FlagIcon
        aria-hidden
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          goal ? "text-muted-foreground" : "text-muted-foreground/40",
        )}
      />
      {editing ? (
        <textarea
          ref={inputRef}
          aria-label="Conversation goal"
          value={draft}
          maxLength={THREAD_GOAL_MAX_LENGTH}
          rows={Math.min(4, Math.max(1, Math.ceil(draft.length / 110)))}
          placeholder="What does finished look like?"
          className="min-w-0 flex-1 resize-none bg-transparent text-foreground leading-5 outline-none placeholder:text-muted-foreground/50"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft(goal ?? "");
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          aria-label={goal ? `Goal: ${goal}. Click to edit.` : "Set a goal for this conversation"}
          className={cn(
            "min-w-0 flex-1 cursor-text text-left leading-5 hover:text-foreground",
            goal ? "text-muted-foreground" : "text-muted-foreground/50 italic",
          )}
          onClick={() => setEditing(true)}
        >
          <span className="line-clamp-2">{goal ?? "No goal yet. Click to set one."}</span>
        </button>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-testid="thread-complete-toggle"
              aria-pressed={isCompleted}
              className={cn(
                "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-accent",
                isCompleted ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
              )}
              onClick={() => void setThreadDone(threadRef, !isCompleted)}
            />
          }
        >
          {isCompleted ? (
            <CheckCircle2Icon className="size-3.5" />
          ) : (
            <CircleIcon className="size-3.5" />
          )}
          <span>{isCompleted ? "Completed" : "Mark completed"}</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {isCompleted
            ? "Reopen. Sending a new message also reopens it."
            : "Hide it from the sidebar. Sending a new message reopens it."}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});
