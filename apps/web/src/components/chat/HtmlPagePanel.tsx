/**
 * The side-panel views of the pages an agent has shown in a conversation: one
 * page with its versions, and the list of all of them.
 *
 * A page in the transcript scrolls away with the conversation; these are what
 * keep it reachable afterwards, and what make a revised page read as one thing
 * that changed rather than a trail of near-identical copies.
 */

import type { EnvironmentId } from "@t3tools/contracts";
import { AppWindowIcon, ChevronLeftIcon, ChevronRightIcon, LayoutListIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { resolveHtmlPageVersion, type HtmlPageState } from "~/session-logic";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { HtmlRenderFrame } from "./HtmlRenderFrame";

function PanelMessage({ title, children }: { title: string; children: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
      <div className="max-w-sm">
        <AppWindowIcon className="mx-auto mb-3 size-5 text-muted-foreground" />
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

export function HtmlPagePanel({
  environmentId,
  page,
  fallbackTitle,
  pinnedVersion,
  onSelectVersion,
  onShowAllPages,
}: {
  environmentId: EnvironmentId;
  /** Null while the conversation is loading, or when the page is no longer in it. */
  page: HtmlPageState | null;
  fallbackTitle: string;
  /** The version the reader chose to stay on; null follows the newest. */
  pinnedVersion: number | null;
  onSelectVersion: (version: number | null) => void;
  onShowAllPages: () => void;
}) {
  if (!page) {
    return (
      <PanelMessage title={fallbackTitle}>
        This page is not in the part of the conversation that is loaded.
      </PanelMessage>
    );
  }
  const shown = resolveHtmlPageVersion(page, pinnedVersion);
  const versionCount = page.versions.length;
  // Stepping onto the newest version goes back to following the agent's
  // revisions rather than pinning the tab to today's newest.
  const selectVersion = (version: number) =>
    onSelectVersion(version >= versionCount ? null : version);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-html-page={page.pageKey}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {shown.reference.title}
        </span>
        {versionCount > 1 ? (
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Earlier version"
              title="Earlier version"
              disabled={shown.version <= 1}
              onClick={() => selectVersion(shown.version - 1)}
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
            <span
              className={cn(
                "px-1 text-xs tabular-nums",
                shown.latest ? "text-muted-foreground" : "font-medium text-warning",
              )}
            >
              Version {shown.version} of {versionCount}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Later version"
              title="Later version"
              disabled={shown.latest}
              onClick={() => selectVersion(shown.version + 1)}
            >
              <ChevronRightIcon className="size-3.5" />
            </Button>
            {shown.latest ? null : (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => onSelectVersion(null)}
              >
                Newest
              </Button>
            )}
          </div>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="All pages in this conversation"
          title="All pages in this conversation"
          onClick={onShowAllPages}
        >
          <LayoutListIcon className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {/* Keyed by the stored file: a new version is a new document, not a reload. */}
        <HtmlRenderFrame
          key={shown.reference.attachmentId}
          environmentId={environmentId}
          reference={shown.reference}
          fill
        />
      </div>
    </div>
  );
}

export function HtmlPagesPanel({
  pages,
  onOpenPage,
}: {
  pages: ReadonlyArray<HtmlPageState>;
  onOpenPage: (page: HtmlPageState) => void;
}) {
  if (pages.length === 0) {
    return (
      <PanelMessage title="No pages yet">
        Charts, mockups and diagrams an agent shows in this conversation are listed here, so you can
        reopen them without scrolling back.
      </PanelMessage>
    );
  }
  // Most recently changed first: the page being worked on is the one wanted.
  const ordered = pages.toSorted((left, right) =>
    (right.versions.at(-1)?.createdAt ?? "").localeCompare(left.versions.at(-1)?.createdAt ?? ""),
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2" data-html-pages-list>
      <ul className="flex flex-col gap-1">
        {ordered.map((page) => {
          const newest = page.versions.at(-1);
          return (
            <li key={page.pageKey}>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-accent/60"
                onClick={() => onOpenPage(page)}
              >
                <AppWindowIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {page.title}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {page.versions.length > 1 ? `${page.versions.length} versions · ` : ""}
                    {newest ? formatRelativeTimeLabel(newest.createdAt) : ""}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
