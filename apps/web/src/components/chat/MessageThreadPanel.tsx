/**
 * The side-thread panel: the message a thread hangs off, everything said in
 * reply to it, and a box to say the next thing.
 *
 * The replies themselves are rendered by the caller and handed in as
 * `timeline` — it is the same component the main conversation uses, so a reply
 * inside a thread looks and behaves like a reply anywhere else (markdown, tool
 * rows, diffs, copy buttons). What it does not get is the "reply in thread"
 * affordance: threads do not nest.
 *
 * The composer here is deliberately plain. Attachments, slash commands and the
 * model picker stay in the main composer; a thread is for pinning down one
 * point, and the reply inherits the conversation's model and mode either way.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CornerDownLeftIcon, CornerUpLeftIcon, MessagesSquareIcon } from "lucide-react";
import type { MessageId, ServerProviderSkill } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";

/** Quote handed over from a text selection, to seed the reply box on open. */
export interface MessageThreadPendingQuote {
  anchorMessageId: MessageId;
  text: string;
  /** Bumped per request so the same quote can be sent twice. */
  requestId: number;
}

export interface MessageThreadPanelProps {
  anchorRole: "user" | "assistant" | "system";
  anchorText: string;
  hasReplies: boolean;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  disabled: boolean;
  disabledReason?: string | undefined;
  /** The reply will join the queue rather than start a turn now. */
  willQueue: boolean;
  pendingQuote?: MessageThreadPendingQuote | undefined;
  /** Resolves false when the send was refused, so the draft survives. */
  onSend: (text: string) => Promise<boolean>;
  onJumpToAnchor: () => void;
  timeline: ReactNode;
}

const MAX_COMPOSER_HEIGHT_PX = 220;

export function MessageThreadPanel({
  anchorRole,
  anchorText,
  hasReplies,
  skills,
  disabled,
  disabledReason,
  willQueue,
  pendingQuote,
  onSend,
  onJumpToAnchor,
  timeline,
}: MessageThreadPanelProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const appliedQuoteRequestIdRef = useRef<number | null>(null);

  // A quote arriving from a selection appends to whatever is already typed, so
  // highlighting a second passage adds to the question rather than replacing it.
  useEffect(() => {
    if (!pendingQuote || appliedQuoteRequestIdRef.current === pendingQuote.requestId) {
      return;
    }
    appliedQuoteRequestIdRef.current = pendingQuote.requestId;
    setDraft((existing) =>
      existing.length === 0 || existing.endsWith("\n")
        ? `${existing}${pendingQuote.text}`
        : `${existing}\n${pendingQuote.text}`,
    );
    textareaRef.current?.focus();
  }, [pendingQuote]);

  // Grow with the draft instead of scrolling a two-line box, capped so a long
  // reply cannot squeeze the thread itself off the panel.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_COMPOSER_HEIGHT_PX)}px`;
  }, [draft]);

  const submit = useCallback(async () => {
    if (sending || disabled) return;
    const text = draft.trim();
    if (text.length === 0) return;
    setSending(true);
    try {
      if (await onSend(text)) {
        setDraft("");
      }
    } finally {
      setSending(false);
    }
  }, [disabled, draft, onSend, sending]);

  const canSend = draft.trim().length > 0 && !sending && !disabled;
  const hint = disabled
    ? (disabledReason ?? "Replies are unavailable right now.")
    : willQueue
      ? "The agent is busy — this will queue."
      : "Enter to send";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <MessagesSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 truncate font-medium text-xs">Thread</p>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={onJumpToAnchor}
                aria-label="Show the message this thread is about"
              />
            }
          >
            <CornerUpLeftIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Show in conversation</TooltipPopup>
        </Tooltip>
      </div>

      {/* The message under discussion, so the thread reads on its own. */}
      <div className="max-h-48 shrink-0 overflow-y-auto border-b border-border/60 bg-muted/25 px-3 py-2">
        <p className="pb-1 text-[10px] text-muted-foreground/70 uppercase tracking-wide">
          {anchorRole === "user" ? "You said" : "The agent said"}
        </p>
        <div className="min-w-0 text-sm">
          <ChatMarkdown text={anchorText} cwd={undefined} skills={skills} lineBreaks />
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {hasReplies ? (
          timeline
        ) : (
          <div className="flex h-full items-center justify-center px-6">
            <p className="text-center text-muted-foreground/50 text-sm">
              No replies yet. Ask about this message and the answer stays here, out of the main
              conversation.
            </p>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border/60 p-2">
        <div
          className={cn(
            "rounded-xl border border-border bg-card p-2 transition-colors focus-within:border-border/90",
            disabled && "opacity-60",
          )}
        >
          <textarea
            ref={textareaRef}
            value={draft}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
            rows={2}
            placeholder="Reply in this thread…"
            className="max-h-[220px] w-full resize-none bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground/60"
          />
          <div className="flex items-center justify-between gap-2 pt-1">
            <p className="min-w-0 truncate text-muted-foreground/70 text-xs">{hint}</p>
            <Button type="button" size="xs" disabled={!canSend} onClick={() => void submit()}>
              <CornerDownLeftIcon className="size-3" />
              {willQueue ? "Queue" : "Send"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
