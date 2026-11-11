import type { ProjectThreadTag, ScopedProjectRef } from "@t3tools/contracts";
import {
  normalizeThreadTagName,
  planThreadTagEdit,
  type ThreadTagEdit,
} from "@t3tools/shared/threadTags";
import { Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { useSidebarThreadFilterStore } from "../sidebarThreadFilter";
import { newCommandId } from "../lib/utils";
import type { SidebarThreadSummary } from "../types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { toastManager } from "./ui/toast";

export interface ThreadTagManagerProject {
  readonly projectKey: string;
  readonly displayName: string;
  readonly vocabulary: readonly ProjectThreadTag[];
  /** Every machine's copy of the project; each keeps its own vocabulary. */
  readonly memberProjectRefs: readonly ScopedProjectRef[];
  /** Live conversations in the project, so a rename can carry them along. */
  readonly threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId" | "id" | "tags">>;
}

/**
 * Where the user fixes tag drift: rename a tag, fold a synonym into the tag it
 * duplicates (rename it to the existing name), sharpen a description so agents
 * pick the right one, or delete a tag. Every conversation carrying the tag
 * follows the change.
 */
export function ThreadTagManagerDialog({
  open,
  onOpenChange,
  projects,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: readonly ThreadTagManagerProject[];
}) {
  const taggedProjects = projects.filter((project) => project.vocabulary.length > 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader className="gap-1.5 pe-10">
          <DialogTitle>Tags</DialogTitle>
          <DialogDescription className="text-xs">
            Rename a tag onto an existing name to merge the two. Descriptions are what agents read
            when picking a tag.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[65vh] space-y-5 overflow-y-auto">
          {taggedProjects.length === 0 ? (
            <p className="text-muted-foreground text-sm">No tags yet.</p>
          ) : (
            taggedProjects.map((project) => (
              <section key={project.projectKey} className="space-y-1">
                {taggedProjects.length > 1 ? (
                  <h3 className="font-medium text-muted-foreground text-xs">
                    {project.displayName}
                  </h3>
                ) : null}
                {project.vocabulary.map((tag) => (
                  <ThreadTagRow key={tag.name} project={project} tag={tag} />
                ))}
              </section>
            ))
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function ThreadTagRow({
  project,
  tag,
}: {
  project: ThreadTagManagerProject;
  tag: ProjectThreadTag;
}) {
  const [name, setName] = useState(tag.name);
  const [description, setDescription] = useState(tag.description);
  const [editingName, setEditingName] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const count = project.threads.filter((thread) => thread.tags.includes(tag.name)).length;

  // Pick up changes made elsewhere (an agent, another machine) unless the user
  // is typing in that field, so a blur never writes stale text back.
  useEffect(() => {
    if (!editingName) setName(tag.name);
  }, [editingName, tag.name]);
  useEffect(() => {
    if (!editingDescription) setDescription(tag.description);
  }, [editingDescription, tag.description]);

  const commitName = () => {
    setEditingName(false);
    const normalized = normalizeThreadTagName(name);
    if (normalized === tag.name || normalized.length === 0) {
      setName(tag.name);
      return;
    }
    void applyThreadTagEdit(project, { kind: "rename", from: tag.name, to: name }).then((ok) => {
      if (!ok) setName(tag.name);
    });
  };
  const commitDescription = () => {
    setEditingDescription(false);
    if (description.trim() === tag.description) return;
    void applyThreadTagEdit(project, { kind: "describe", name: tag.name, description });
  };

  return (
    <div className="grid grid-cols-[9rem_1fr_auto_auto] items-center gap-2 py-1">
      <Input
        aria-label={`Name of tag ${tag.name}`}
        size="sm"
        value={name}
        onFocus={() => setEditingName(true)}
        onChange={(event) => setName(event.target.value)}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <Input
        aria-label={`Description of tag ${tag.name}`}
        size="sm"
        value={description}
        placeholder="What belongs under this tag"
        onFocus={() => setEditingDescription(true)}
        onChange={(event) => setDescription(event.target.value)}
        onBlur={commitDescription}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <span className="w-6 text-right text-muted-foreground text-xs tabular-nums">{count}</span>
      <Button
        aria-label={`Delete tag ${tag.name}`}
        size="icon-xs"
        variant="ghost"
        onClick={() => {
          const message =
            count > 0
              ? `Delete "${tag.name}"? It is removed from ${count} conversation${count === 1 ? "" : "s"}.`
              : `Delete "${tag.name}"?`;
          if (window.confirm(message)) {
            void applyThreadTagEdit(project, { kind: "delete", name: tag.name });
          }
        }}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}

async function applyThreadTagEdit(
  project: ThreadTagManagerProject,
  edit: ThreadTagEdit,
): Promise<boolean> {
  const plan = planThreadTagEdit(project.vocabulary, project.threads, edit);
  if ("error" in plan) {
    toastManager.add({ type: "error", title: plan.error });
    return false;
  }
  try {
    // Every machine's copy gets the same vocabulary, so the tag lists stop
    // disagreeing the moment the user touches them.
    for (const ref of project.memberProjectRefs) {
      const api = readEnvironmentApi(ref.environmentId);
      if (!api) continue;
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: ref.projectId,
        threadTags: plan.vocabulary,
      });
    }
    for (const [index, tags] of plan.threadTags) {
      const thread = project.threads[index];
      if (!thread) continue;
      const api = readEnvironmentApi(thread.environmentId);
      if (!api) continue;
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: thread.id,
        tags,
      });
    }
    // A filter on the old name would otherwise leave the list empty with no
    // checkbox left to untick.
    if (edit.kind !== "describe") {
      const from = edit.kind === "rename" ? edit.from : edit.name;
      const to =
        edit.kind === "rename" ? (plan.mergedInto ?? normalizeThreadTagName(edit.to)) : null;
      useSidebarThreadFilterStore.getState().remapTag(project.projectKey, from, to);
    }
    if (plan.mergedInto) {
      toastManager.add({ type: "success", title: `Merged into "${plan.mergedInto}"` });
    }
    return true;
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Could not update the tag",
      description: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
