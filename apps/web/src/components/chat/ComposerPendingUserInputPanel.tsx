import { memo, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { ComposerPendingCollapseToggle } from "./ComposerPendingCollapseToggle";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionLabel: string) => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={isResponding}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
    />
  );
});

/**
 * Nothing here ever chooses for the user. Options start unselected, a click
 * only ticks or unticks, and moving to the next question or sending is always
 * an explicit Next/Submit — never a side effect of picking.
 */
const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionLabel: string) => void;
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  // Local, and reset per request because the panel remounts on `requestId`.
  const [isCollapsed, setIsCollapsed] = useState(false);
  const optionsId = useId();
  const optionsRef = useRef<HTMLDivElement>(null);
  const collapseToggleRef = useRef<HTMLButtonElement>(null);

  // Collapsing hides the options with `hidden`. If focus was sitting on one of
  // them it would land back on <body> and the next Tab would restart from the
  // top of the document, so hand it to the toggle instead.
  const handleCollapseToggle = () => {
    const collapsing = !isCollapsed;
    if (collapsing && optionsRef.current?.contains(document.activeElement)) {
      collapseToggleRef.current?.focus();
    }
    setIsCollapsed(collapsing);
  };

  const handleOptionSelection = useEffectEvent((questionId: string, optionLabel: string) => {
    onToggleOption(questionId, optionLabel);
  });

  // Keyboard shortcut: number keys 1-9 toggle the matching option when focus is
  // outside editable fields. Like a click, a shortcut never advances or sends.
  // While the card is collapsed the options are off-screen, so the shortcuts
  // are parked too — otherwise a stray digit answers a question you cannot see.
  useEffect(() => {
    if (!activeQuestion || isResponding || isCollapsed) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      handleOptionSelection(activeQuestion.id, option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, isResponding, isCollapsed]);

  if (!activeQuestion) {
    return null;
  }

  const customAnswerActive = progress.customAnswer.trim().length > 0;
  const selectedCount = customAnswerActive ? 0 : progress.selectedOptionLabels.length;

  return (
    <div className={cn("px-4 sm:px-5", isCollapsed ? "py-2" : "py-3")}>
      <div className={cn("flex items-center gap-3", isCollapsed ? "gap-2" : "mb-2")}>
        <span className="text-[11px] font-semibold tracking-widest text-muted-foreground/55 uppercase">
          {activeQuestion.header}
        </span>
        {prompt.questions.length > 1 ? (
          <span className="flex h-5 items-center rounded-md bg-muted/60 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground/60">
            {questionIndex + 1}/{prompt.questions.length}
          </span>
        ) : null}
        {isCollapsed ? (
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground/80">
            {activeQuestion.question}
          </span>
        ) : null}
        <ComposerPendingCollapseToggle
          ref={collapseToggleRef}
          className={isCollapsed ? undefined : "ml-auto"}
          isCollapsed={isCollapsed}
          controlsId={optionsId}
          collapseLabel="Hide question"
          expandLabel="Show question"
          onToggle={handleCollapseToggle}
        />
      </div>
      <div id={optionsId} ref={optionsRef} hidden={isCollapsed}>
        <p className="text-sm text-foreground/90">{activeQuestion.question}</p>
        {activeQuestion.multiSelect ? (
          <p className="mt-1 text-xs text-muted-foreground/65">
            {selectedCount > 0
              ? `${selectedCount} selected — keep picking, then ${
                  progress.isLastQuestion ? "submit" : "continue"
                }.`
              : "Select one or more options."}
          </p>
        ) : null}
        {/* Cap the option list so a long set can never swallow the viewport on a
            phone; the list gets its own scroller instead of stealing every pixel
            from the timeline above. */}
        {/* dvh, not vh: on iOS Safari `vh` resolves against the large viewport
            and does not shrink when the keyboard opens — which is exactly the
            case this cap exists for. */}
        <div
          role={activeQuestion.multiSelect ? "group" : "radiogroup"}
          aria-label={activeQuestion.question}
          className="mt-3 max-h-[38dvh] space-y-1.5 overflow-y-auto overscroll-contain pr-0.5 sm:max-h-[46dvh]"
        >
          {activeQuestion.options.map((option, index) => {
            const isSelected =
              !customAnswerActive && progress.selectedOptionLabels.includes(option.label);
            const shortcutKey = index < 9 ? index + 1 : null;
            const className = cn(
              "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-all duration-150 focus-visible:border-primary/40 focus-visible:ring-1 focus-visible:ring-primary/25",
              isSelected
                ? "border-primary/30 bg-primary/8 text-foreground"
                : "border-transparent bg-muted/22 text-foreground/85 hover:border-border/45 hover:bg-muted/34",
              isResponding && "opacity-50 cursor-not-allowed",
              !isResponding && "cursor-pointer",
            );
            const content = (
              <>
                {/* A tick box, only on multi-select: the one thing that tells
                    you at a glance that picking one does not close the list. */}
                {activeQuestion.multiSelect ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-150",
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border/70 bg-background/40 group-hover:border-border",
                    )}
                  >
                    {isSelected ? <CheckIcon className="size-3" /> : null}
                  </span>
                ) : null}
                <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{option.label}</span>
                  {option.description && option.description !== option.label ? (
                    <span className="text-xs text-muted-foreground/50">{option.description}</span>
                  ) : null}
                </div>
                {isSelected && !activeQuestion.multiSelect ? (
                  <CheckIcon className="size-3.5 shrink-0 text-primary" />
                ) : shortcutKey !== null ? (
                  <kbd
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded border border-border/50 text-[11px] font-medium tabular-nums transition-colors duration-150",
                      "bg-background/35 text-muted-foreground/70 group-hover:border-border/70 group-hover:text-muted-foreground",
                    )}
                  >
                    {shortcutKey}
                  </kbd>
                ) : null}
              </>
            );
            return (
              <div
                key={`${activeQuestion.id}:${option.label}`}
                role={activeQuestion.multiSelect ? "checkbox" : "radio"}
                aria-checked={isSelected}
                tabIndex={isResponding ? -1 : 0}
                aria-disabled={isResponding}
                onClick={() => {
                  if (isResponding) return;
                  handleOptionSelection(activeQuestion.id, option.label);
                }}
                className={className}
              >
                {content}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
