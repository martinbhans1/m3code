import { PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectToolServerConfig, ProjectToolServerId } from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";

import { normalizeProjectPathForComparison } from "../../lib/projectPaths";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  describeToolServerReach,
  hasStoredToolServerCredential,
  newProjectToolServerId,
  resolvePublishableToolServers,
  toToolServerEntries,
  toolServerNameIssue,
  type ProjectToolServerEntry,
} from "./projectToolServers.logic";

/** Direct row in the card – same pattern as the Database / Connections list rows. */
const ITEM_ROW_CLASSNAME = "border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5";

/** Sentinel for the "Every project" option — `projectPath: ""` in the contract. */
const ALL_PROJECTS_VALUE = "*";

const DEFAULT_AUTH_HEADER = "Authorization";

type ProjectToolServerRowProps = {
  readonly row: ProjectToolServerEntry;
  readonly index: number;
  readonly projectOptions: ReadonlyArray<{ readonly cwd: string; readonly name: string }>;
  readonly savedServer: ProjectToolServerConfig | undefined;
  readonly onChange: (id: ProjectToolServerId, patch: Partial<ProjectToolServerConfig>) => void;
  readonly onRemove: (id: ProjectToolServerId) => void;
};

function ProjectToolServerRow({
  row,
  index,
  projectOptions,
  savedServer,
  onChange,
  onRemove,
}: ProjectToolServerRowProps) {
  const isSharedWithEveryProject = row.projectPath.length === 0;
  const selectedProjectValue = isSharedWithEveryProject ? ALL_PROJECTS_VALUE : row.projectPath;
  const selectedProjectLabel = isSharedWithEveryProject
    ? "Every project"
    : (projectOptions.find(
        (project) =>
          normalizeProjectPathForComparison(project.cwd) ===
          normalizeProjectPathForComparison(row.projectPath),
      )?.name ?? row.projectPath);
  const nameIssue = toolServerNameIssue(row.name);
  const hadStoredCredential = hasStoredToolServerCredential(savedServer);
  const reach = describeToolServerReach({
    enabled: row.enabled,
    name: row.name,
    url: row.url,
    projectLabel: selectedProjectLabel,
    isSharedWithEveryProject,
  });

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Name in settings</span>
          <DraftInput
            value={row.label}
            onCommit={(label) => onChange(row.id, { label })}
            placeholder="Team chat"
            spellCheck={false}
            aria-label={`Tool server label ${index + 1}`}
          />
        </label>
        {/* Not a <label>: it wraps a button trigger, which a label would re-toggle. */}
        <div className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Project</span>
          <Select
            value={selectedProjectValue}
            onValueChange={(value) =>
              onChange(row.id, {
                projectPath: value === ALL_PROJECTS_VALUE ? "" : String(value),
              })
            }
          >
            <SelectTrigger className="w-full" aria-label={`Tool server project ${index + 1}`}>
              <SelectValue>{selectedProjectLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value={ALL_PROJECTS_VALUE}>
                Every project (costs every conversation)
              </SelectItem>
              {projectOptions.map((project) => (
                <SelectItem hideIndicator key={project.cwd} value={project.cwd}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            Name the assistant uses
          </span>
          <DraftInput
            value={row.name}
            onCommit={(name) => onChange(row.id, { name })}
            placeholder="team-chat"
            spellCheck={false}
            autoComplete="off"
            aria-label={`Tool server name ${index + 1}`}
          />
          <span className="mt-1.5 block text-xs text-muted-foreground">
            {nameIssue ??
              "What a conversation calls this server when it talks about using its tools."}
          </span>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Address</span>
          <DraftInput
            value={row.url}
            onCommit={(url) => onChange(row.id, { url })}
            placeholder="https://tools.example.com/mcp"
            spellCheck={false}
            autoComplete="off"
            aria-label={`Tool server address ${index + 1}`}
          />
          <span className="mt-1.5 block text-xs text-muted-foreground">
            The endpoint the service published for its tools.
          </span>
        </label>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Sent in header</span>
          <DraftInput
            value={row.authHeader}
            onCommit={(authHeader) =>
              onChange(row.id, { authHeader: authHeader.trim() || DEFAULT_AUTH_HEADER })
            }
            placeholder={DEFAULT_AUTH_HEADER}
            spellCheck={false}
            autoComplete="off"
            aria-label={`Tool server header ${index + 1}`}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            Key or token (optional)
          </span>
          <DraftInput
            value={row.authValueRedacted ? "" : row.authValue}
            onCommit={(authValue) => onChange(row.id, { authValue })}
            type="password"
            autoComplete="off"
            placeholder={
              row.authValueRedacted ? "Saved - type a new value to replace it" : "Bearer sk-..."
            }
            spellCheck={false}
            aria-label={`Tool server key ${index + 1}`}
          />
          <span className="mt-1.5 block text-xs text-muted-foreground">
            {row.authValueRedacted
              ? "Kept outside settings and never shown again. Leave it untouched to keep it."
              : hadStoredCredential
                ? "The saved key is dropped when this entry saves."
                : "Leave empty for a service that needs no key."}
          </span>
        </label>
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-xs text-muted-foreground">{reach}</p>
        <div className="flex shrink-0 items-center gap-2 sm:justify-end">
          {row.authValueRedacted ? (
            <Button size="xs" variant="outline" onClick={() => onChange(row.id, { authValue: "" })}>
              Forget key
            </Button>
          ) : null}
          <Switch
            checked={row.enabled}
            onCheckedChange={(enabled) => onChange(row.id, { enabled: Boolean(enabled) })}
            aria-label={`Offer ${row.label || `tool server ${index + 1}`} to conversations`}
          />
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-8 text-muted-foreground hover:text-destructive"
            onClick={() => onRemove(row.id)}
            aria-label={`Remove tool server ${row.label || index + 1}`}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ProjectToolServersPanel() {
  const toolServers = useSettings((settings) => settings.projectToolServers);
  const { updateSettings } = useUpdateSettings();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));

  const [rows, setRows] = useState<ReadonlyArray<ProjectToolServerEntry>>(() => [
    ...toToolServerEntries(toolServers),
  ]);

  // Server pushes are authoritative; local rows only diverge while a new entry
  // is still missing the fields it needs to be saved (see `publishRows`).
  useEffect(() => {
    setRows((current) => {
      const saved = toToolServerEntries(toolServers);
      const savedIds = new Set(saved.map((entry) => entry.id));
      const pending = current.filter((entry) => !savedIds.has(entry.id));
      return [...saved, ...pending];
    });
  }, [toolServers]);

  const projectOptions = useMemo(() => {
    const byPath = new Map<string, { readonly cwd: string; readonly name: string }>();
    for (const project of projects) {
      const key = normalizeProjectPathForComparison(project.cwd);
      if (!byPath.has(key)) {
        byPath.set(key, { cwd: project.cwd, name: project.name });
      }
    }
    return [...byPath.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [projects]);

  /** Whole-map replacement — `ServerSettingsPatch.projectToolServers` has no per-entry patch. */
  const publishRows = useCallback(
    (nextRows: ReadonlyArray<ProjectToolServerEntry>) => {
      updateSettings({ projectToolServers: resolvePublishableToolServers(nextRows, toolServers) });
    },
    [toolServers, updateSettings],
  );

  const handleChange = useCallback(
    (id: ProjectToolServerId, patch: Partial<ProjectToolServerConfig>) => {
      const nextRows = rows.map((row) => {
        if (row.id !== id) return row;
        const next = { ...row, ...patch };
        if (patch.authValue !== undefined) {
          // A typed value replaces the saved key; an empty one forgets it.
          // Either way the redaction flag has to go, or the server keeps the
          // old key instead of storing what was entered.
          delete next.authValueRedacted;
        }
        return next;
      });
      setRows(nextRows);
      publishRows(nextRows);
    },
    [publishRows, rows],
  );

  const handleRemove = useCallback(
    (id: ProjectToolServerId) => {
      const nextRows = rows.filter((row) => row.id !== id);
      setRows(nextRows);
      publishRows(nextRows);
    },
    [publishRows, rows],
  );

  const handleAdd = useCallback(() => {
    // Default to a real project, never the shared scope: tools handed to every
    // conversation are paid for by every conversation, so that has to be a
    // deliberate choice rather than the result of not making one.
    const defaultProject = projectOptions[0];
    setRows((current) => [
      ...current,
      {
        id: newProjectToolServerId(),
        label: "",
        name: "",
        projectPath: defaultProject?.cwd ?? "",
        url: "",
        authHeader: DEFAULT_AUTH_HEADER,
        authValue: "",
        enabled: true,
      },
    ]);
  }, [projectOptions]);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Tool servers"
        headerAction={
          <Button size="xs" variant="default" onClick={handleAdd}>
            <PlusIcon className="size-3" />
            Add tool server
          </Button>
        }
      >
        <SettingsRow
          title="Extra tools for a project's conversations"
          description="Point a project at a team chat, an issue tracker, or anything else that publishes tools over its own endpoint, and conversations working in that project can use it. Choose every project instead and every conversation is handed it, including the ones that will never need it — each paying for it in the room it has left to think, so it is rarely what you want. A change here reaches the next conversation that starts, never one already running."
        />
        {rows.length === 0 ? (
          <SettingsRow
            title="No tool servers"
            description="Nothing extra is offered yet. Conversations still have their usual tools."
          />
        ) : (
          rows.map((row, index) => (
            <ProjectToolServerRow
              key={row.id}
              row={row}
              index={index}
              projectOptions={projectOptions}
              savedServer={toolServers[row.id]}
              onChange={handleChange}
              onRemove={handleRemove}
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
