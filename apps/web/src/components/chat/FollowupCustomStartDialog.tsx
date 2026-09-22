import { useEffect, useState } from "react";

import type {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "~/providerInstances";
import type { FollowupState } from "~/session-logic";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import type { FollowupProjectChoice } from "./FollowupChipDeck";
import { ProviderModelPicker } from "./ProviderModelPicker";
import type { ModelEsque } from "./providerIconUtils";

/** Which conversation runs the work. */
export type FollowupStartTarget = "newThread" | "currentChat";

export interface FollowupCustomStartOptions {
  /** Free text the user added; folded into the prompt under its own heading. */
  extraContext: string;
  /**
   * `currentChat` sends the task as the next turn here instead of opening a
   * conversation for it — the same thing the "Fix in this session" menu item
   * does, but reachable without losing the context box and the model picker.
   */
  target: FollowupStartTarget;
  /**
   * Provider/model to run the task on. Null means "whatever the composer is
   * already set to", which is the default and the common case.
   */
  modelSelection: { instanceId: ProviderInstanceId; model: string } | null;
  worktree: boolean;
  projectId: ProjectId | null;
  /**
   * Write a handoff link on both threads and badge this one in the sidebar, so
   * a conversation whose work has genuinely moved on reads that way at a glance
   * without being archived.
   */
  markHandoff: boolean;
}

type Destination = "local" | "worktree" | `project:${string}`;

/**
 * The long form of "Start locally". A follow-up is written by the agent in a
 * sentence or two, which is frequently not enough to open a conversation with —
 * this is where the missing context gets added, where the provider and model
 * for the work are chosen, and where you say that this conversation is finished
 * with the work.
 */
export function FollowupCustomStartDialog({
  followup,
  open,
  onOpenChange,
  canStartInWorktree,
  canRunInCurrentChat,
  projectChoices,
  instanceEntries,
  modelOptionsByInstance,
  defaultModelSelection,
  lockedProvider,
  keybindings,
  getModelDisabledReason,
  onStart,
}: {
  followup: FollowupState | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canStartInWorktree: boolean;
  /** False on a draft/unstarted thread, where there is no session to send to. */
  canRunInCurrentChat: boolean;
  projectChoices?: ReadonlyArray<FollowupProjectChoice> | undefined;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  /** The composer's current pick, used as the dialog's starting point. */
  defaultModelSelection: { instanceId: ProviderInstanceId; model: string } | null;
  /** Driver this thread's live session is pinned to, if any. */
  lockedProvider?: ProviderDriverKind | null;
  keybindings?: ResolvedKeybindingsConfig;
  /**
   * Why a model cannot be used for another turn in *this* thread. Only consulted
   * when the task is going to run here — a new conversation has no session yet,
   * so nothing is off limits.
   */
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onStart: (followup: FollowupState, options: FollowupCustomStartOptions) => void;
}) {
  const hasProjectChoices = projectChoices !== undefined && projectChoices.length > 0;
  const firstProjectId = projectChoices?.[0]?.id ?? null;
  const [extraContext, setExtraContext] = useState("");
  const [target, setTarget] = useState<FollowupStartTarget>("newThread");
  const [destination, setDestination] = useState<Destination>("local");
  const [markHandoff, setMarkHandoff] = useState(false);
  const [selection, setSelection] = useState<{
    instanceId: ProviderInstanceId;
    model: string;
  } | null>(null);

  // Each follow-up gets a clean form. Carrying the previous one's context or
  // checkbox over is the kind of thing you only notice after it has already
  // been sent into a new conversation.
  //
  // Deps are the first project *id*, never the `projectChoices` array itself:
  // on an orchestrator thread that array is memoized on `activeThread`, whose
  // identity changes on every websocket update, so depending on it would wipe
  // whatever the user was typing the moment any activity arrived.
  useEffect(() => {
    if (open) {
      setExtraContext("");
      setTarget("newThread");
      setDestination(firstProjectId !== null ? `project:${firstProjectId}` : "local");
      setMarkHandoff(false);
      setSelection(defaultModelSelection);
    }
  }, [open, followup?.id, firstProjectId, defaultModelSelection]);

  if (!followup) {
    return null;
  }

  const runsHere = target === "currentChat";
  const activeSelection = selection ?? defaultModelSelection;
  // A live session pins the driver, so the same rule the composer's picker uses
  // applies here — but only while the task is aimed at this conversation.
  const disabledReason = runsHere ? getModelDisabledReason : undefined;

  const chooseTarget = (next: FollowupStartTarget) => {
    setTarget(next);
    // Switching to "this conversation" can strand a pick the live session will
    // not accept. Fall back to the composer's own selection rather than letting
    // Start fail on a model the picker would have greyed out.
    if (
      next === "currentChat" &&
      activeSelection &&
      getModelDisabledReason?.(activeSelection.instanceId, activeSelection.model)
    ) {
      setSelection(defaultModelSelection);
    }
  };

  const submit = () => {
    onOpenChange(false);
    onStart(followup, {
      extraContext,
      target,
      modelSelection: activeSelection,
      worktree: !runsHere && destination === "worktree",
      projectId:
        !runsHere && destination.startsWith("project:")
          ? (destination.slice("project:".length) as ProjectId)
          : null,
      markHandoff: !runsHere && markHandoff,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader className="gap-1.5 pe-10">
          <DialogDescription className="text-xs">Start suggested task</DialogDescription>
          <DialogTitle>{followup.title}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="followup-extra-context">Additional context</Label>
            <textarea
              id="followup-extra-context"
              value={extraContext}
              onChange={(event) => setExtraContext(event.target.value)}
              rows={5}
              autoFocus
              placeholder="Anything the suggestion is missing — constraints, the file to start from, what not to touch…"
              className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <p className="text-xs text-muted-foreground">
              Sent as your own note on top of the suggestion, and told to take precedence over it.
            </p>
          </div>

          {canRunInCurrentChat ? (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">Run it</legend>
              <label className="flex items-center gap-2.5 text-sm hover:cursor-pointer">
                <input
                  type="radio"
                  name="followup-target"
                  className="size-4 accent-primary"
                  checked={target === "newThread"}
                  onChange={() => chooseTarget("newThread")}
                />
                <span>
                  In a new conversation
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    keeps this one on its own subject
                  </span>
                </span>
              </label>
              <label className="flex items-center gap-2.5 text-sm hover:cursor-pointer">
                <input
                  type="radio"
                  name="followup-target"
                  className="size-4 accent-primary"
                  checked={runsHere}
                  onChange={() => chooseTarget("currentChat")}
                />
                <span>
                  In this conversation
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    sent as the next turn here
                  </span>
                </span>
              </label>
            </fieldset>
          ) : null}

          <div className="space-y-1.5">
            <Label>Model</Label>
            <div className="flex">
              {activeSelection ? (
                <ProviderModelPicker
                  activeInstanceId={activeSelection.instanceId}
                  model={activeSelection.model}
                  lockedProvider={runsHere ? (lockedProvider ?? null) : null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  triggerVariant="outline"
                  triggerClassName="h-8"
                  {...(keybindings ? { keybindings } : {})}
                  {...(disabledReason ? { getModelDisabledReason: disabledReason } : {})}
                  onInstanceModelChange={(instanceId, model) => setSelection({ instanceId, model })}
                />
              ) : (
                <p className="text-sm text-muted-foreground">No provider configured.</p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {runsHere
                ? "Used for this turn. Models a started session cannot switch to are greyed out."
                : "The new conversation starts on this provider and model."}
            </p>
          </div>

          {runsHere ? null : (
            <>
              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm font-medium">Where</legend>
                {hasProjectChoices ? (
                  projectChoices.map((project) => (
                    <label
                      key={project.id}
                      className="flex items-center gap-2.5 text-sm hover:cursor-pointer"
                    >
                      <input
                        type="radio"
                        name="followup-destination"
                        className="size-4 accent-primary"
                        checked={destination === `project:${project.id}`}
                        onChange={() => setDestination(`project:${project.id}`)}
                      />
                      <span>{project.name}</span>
                    </label>
                  ))
                ) : (
                  <>
                    <label className="flex items-center gap-2.5 text-sm hover:cursor-pointer">
                      <input
                        type="radio"
                        name="followup-destination"
                        className="size-4 accent-primary"
                        checked={destination === "local"}
                        onChange={() => setDestination("local")}
                      />
                      <span>
                        In this checkout
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          shares the working tree with this conversation
                        </span>
                      </span>
                    </label>
                    {canStartInWorktree ? (
                      <label className="flex items-center gap-2.5 text-sm hover:cursor-pointer">
                        <input
                          type="radio"
                          name="followup-destination"
                          className="size-4 accent-primary"
                          checked={destination === "worktree"}
                          onChange={() => setDestination("worktree")}
                        />
                        <span>
                          In a new worktree
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            isolated; cannot disturb this one
                          </span>
                        </span>
                      </label>
                    ) : null}
                  </>
                )}
              </fieldset>

              <label className="flex items-start gap-2.5 text-sm hover:cursor-pointer">
                <Checkbox
                  checked={markHandoff}
                  onCheckedChange={(checked) => setMarkHandoff(Boolean(checked))}
                  className="mt-0.5"
                />
                <span>
                  Mark this conversation as handed off
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Adds a link to the new conversation at the end of this one and flags it in the
                    sidebar, so you know you can look away from it. Nothing is archived.
                  </span>
                </span>
              </label>
            </>
          )}
        </DialogPanel>
        <DialogFooter variant="bare" className="flex-row items-center justify-end">
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit}>
            Start
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
