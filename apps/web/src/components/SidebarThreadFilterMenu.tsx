import { ListFilterIcon } from "lucide-react";
import { useState } from "react";

import { countActiveSidebarFilters, useSidebarThreadFilterStore } from "../sidebarThreadFilter";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ThreadTagManagerDialog, type ThreadTagManagerProject } from "./ThreadTagManagerDialog";

export interface SidebarThreadFilterProject extends ThreadTagManagerProject {
  /** Live (unarchived) conversations carrying each tag. */
  readonly tagCounts: ReadonlyMap<string, number>;
}

/**
 * The sidebar's Filter button. Deliberately a menu rather than chips on the
 * project rows: the rows are already full, and tags are something the user
 * reaches for when looking for past work, not something to scan constantly.
 */
export function SidebarThreadFilterMenu({
  projects,
}: {
  projects: readonly SidebarThreadFilterProject[];
}) {
  const hideCompleted = useSidebarThreadFilterStore((state) => state.hideCompleted);
  const selectedTagsByProject = useSidebarThreadFilterStore((state) => state.selectedTagsByProject);
  const setHideCompleted = useSidebarThreadFilterStore((state) => state.setHideCompleted);
  const toggleTag = useSidebarThreadFilterStore((state) => state.toggleTag);
  const clearTags = useSidebarThreadFilterStore((state) => state.clearTags);
  const activeCount = countActiveSidebarFilters({ hideCompleted, selectedTagsByProject });
  const hasTagSelection = Object.values(selectedTagsByProject).some((tags) => tags.length > 0);
  const taggedProjects = projects.filter((project) => project.vocabulary.length > 0);
  const [managerOpen, setManagerOpen] = useState(false);

  return (
    <>
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                aria-label="Filter conversations"
                data-testid="sidebar-thread-filter-trigger"
                className="relative inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-[calc(--spacing(1)-1px)] text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground data-[active=true]:text-foreground"
                data-active={hasTagSelection}
              />
            }
          >
            <ListFilterIcon className="size-3.5" />
            {hasTagSelection ? (
              <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary" />
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="right">
            {activeCount > 0 ? `Filter (${activeCount} active)` : "Filter"}
          </TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" side="bottom" className="max-h-[70vh] min-w-56 overflow-y-auto">
          <MenuGroup>
            <MenuGroupLabel>Status</MenuGroupLabel>
            <MenuCheckboxItem
              checked={hideCompleted}
              onCheckedChange={(checked) => setHideCompleted(checked)}
              className="sm:text-xs"
            >
              Hide completed
            </MenuCheckboxItem>
          </MenuGroup>
          {taggedProjects.map((project) => {
            const selected = selectedTagsByProject[project.projectKey] ?? [];
            return (
              <MenuGroup key={project.projectKey}>
                <MenuSeparator />
                <MenuGroupLabel>
                  {taggedProjects.length > 1 ? `Tags · ${project.displayName}` : "Tags"}
                </MenuGroupLabel>
                {project.vocabulary.map((tag) => (
                  <MenuCheckboxItem
                    key={tag.name}
                    checked={selected.includes(tag.name)}
                    onCheckedChange={() => toggleTag(project.projectKey, tag.name)}
                    closeOnClick={false}
                    className="sm:text-xs"
                    title={tag.description}
                  >
                    <span className="flex min-w-0 items-center justify-between gap-3">
                      <span className="truncate">{tag.name}</span>
                      <span className="text-muted-foreground/60 tabular-nums">
                        {project.tagCounts.get(tag.name) ?? 0}
                      </span>
                    </span>
                  </MenuCheckboxItem>
                ))}
              </MenuGroup>
            );
          })}
          {taggedProjects.length === 0 ? (
            <div className="px-2 pt-1 pb-2 text-muted-foreground/70 text-xs">
              No tags yet. Agents tag conversations as they work.
            </div>
          ) : null}
          {hasTagSelection || taggedProjects.length > 0 ? <MenuSeparator /> : null}
          {hasTagSelection ? (
            <MenuItem className="sm:text-xs" onClick={clearTags}>
              Clear tag filters
            </MenuItem>
          ) : null}
          {taggedProjects.length > 0 ? (
            <MenuItem className="sm:text-xs" onClick={() => setManagerOpen(true)}>
              Manage tags…
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
      <ThreadTagManagerDialog
        open={managerOpen}
        onOpenChange={setManagerOpen}
        projects={projects}
      />
    </>
  );
}
