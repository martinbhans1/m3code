import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { CornerUpLeftIcon } from "lucide-react";
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useIsMobile } from "~/hooks/useMediaQuery";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { cn } from "~/lib/utils";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  gitCwd: string | null;
  /**
   * Set when this thread was spun off from another conversation. Rendered as a
   * backlink rather than a transcript entry: it is context for the whole thread,
   * not something that happened partway through it.
   */
  sourceHandoff?: { counterpartThreadId: ThreadId; counterpartTitle: string } | null;
  /** Navigation is passed in so this presentational header stays router-free. */
  onOpenThread: (threadId: ThreadId) => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  rightPanelOpen: boolean;
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  gitCwd,
  sourceHandoff,
  onOpenThread,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  rightPanelOpen,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isMobile = useIsMobile();
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  // Brand-new draft threads have no title yet; show a placeholder so the header
  // is never blank and always signals which repo you're in.
  const titleText = activeThreadTitle.trim().length > 0 ? activeThreadTitle : "New thread";
  const headerLabel = activeProjectName ? `${activeProjectName} / ${titleText}` : titleText;
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        {sourceHandoff ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`Spun off from ${sourceHandoff.counterpartTitle}`}
                  className="-ml-1 inline-flex shrink-0 items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground hover:cursor-pointer"
                  onClick={() => onOpenThread(sourceHandoff.counterpartThreadId)}
                />
              }
            >
              <CornerUpLeftIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              Spun off from “{sourceHandoff.counterpartTitle}” — open it
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {isMobile ? (
          // On a phone a single `project / title` line truncates to a few
          // characters of the thread name, and a hover tooltip is unreachable
          // on touch. Stack the two on their own lines (the 52px topbar has
          // room) and make the block tappable to read either one in full.
          <h2 className="min-w-0 flex-1" aria-label={headerLabel}>
            <Popover>
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    className="-mx-1.5 block w-full min-w-0 rounded-md px-1.5 py-1 text-left active:bg-muted/60"
                  />
                }
              >
                <span className="block truncate text-[11px] font-medium leading-tight text-muted-foreground">
                  {activeProjectName ?? "No project"}
                </span>
                <span className="block truncate text-[13px] font-medium leading-tight text-foreground">
                  {titleText}
                </span>
              </PopoverTrigger>
              <PopoverPopup
                align="start"
                side="bottom"
                className="max-w-[min(22rem,calc(100vw-1.5rem))]"
              >
                <div className="space-y-1.5">
                  {activeProjectName ? (
                    <p className="wrap-break-word text-xs font-medium text-muted-foreground">
                      {activeProjectName}
                    </p>
                  ) : null}
                  <p className="wrap-break-word text-sm font-medium text-foreground">{titleText}</p>
                </div>
              </PopoverPopup>
            </Popover>
          </h2>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <h2
                  aria-label={headerLabel}
                  className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
                >
                  {activeProjectName ? (
                    <span className="font-normal text-muted-foreground">
                      {activeProjectName}
                      <span className="px-1 text-muted-foreground/50">/</span>
                    </span>
                  ) : null}
                  {titleText}
                </h2>
              }
            />
            <TooltipPopup side="top">{headerLabel}</TooltipPopup>
          </Tooltip>
        )}
      </div>
      <div
        data-chat-header-actions
        className={cn(
          "flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3",
          rightPanelOpen ? "pr-0" : "pr-16",
        )}
      >
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {showOpenInPicker && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {activeProjectName && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            {...(draftId ? { draftId } : {})}
          />
        )}
      </div>
    </div>
  );
});
