import type { EnvironmentId } from "@t3tools/contracts";
import {
  htmlRenderFrameHeight,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  type HtmlRenderReference,
  type HtmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import { Maximize2Icon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { useAssetUrl } from "../../assets/assetUrls";
import { useTheme } from "../../hooks/useTheme";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { readHtmlRenderTheme, resolveHtmlRenderFrameMessage } from "./htmlRenderFrame.logic";

/** The app's theme for pages, kept current as the theme or its variables change. */
function useHtmlRenderTheme(): HtmlRenderTheme {
  const { resolvedTheme } = useTheme();
  const [theme, setTheme] = useState(() =>
    readHtmlRenderTheme(document.documentElement, resolvedTheme),
  );
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setTheme(readHtmlRenderTheme(root, resolvedTheme));
    update();
    // The theme lands as a class or inline variables on the root element.
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, [resolvedTheme]);
  return theme;
}

function openExternalLink(url: string) {
  const api = readLocalApi();
  if (api) {
    void api.shell.openExternal(url).catch(() => undefined);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function hasRecentUserActivation(): boolean {
  return navigator.userActivation?.isActive === true;
}

/**
 * One agent-authored page in a sandboxed frame. The frame has scripts and
 * forms but never `allow-same-origin` (the page could then reach the app) or
 * `allow-modals`; the server's CSP sandboxes the document a second time.
 */
export function HtmlRenderFrame({
  environmentId,
  reference,
  fill = false,
}: {
  environmentId: EnvironmentId;
  reference: HtmlRenderReference;
  /** Take the parent's full height instead of the page's own. */
  fill?: boolean;
}) {
  const url = useAssetUrl(environmentId, {
    _tag: "attachment",
    attachmentId: reference.attachmentId,
  });
  const theme = useHtmlRenderTheme();
  // Signed URLs are re-issued before they expire; a new src would reload the
  // page and lose its state, so the frame keeps the first one it got.
  const [src, setSrc] = useState<string | null>(null);
  if (src === null && url !== null) {
    setSrc(`${url}${htmlRenderThemeFragment(theme)}`);
  }
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [reportedHeight, setReportedHeight] = useState<number | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const action = resolveHtmlRenderFrameMessage({
        source: event.source,
        frameWindow: frameRef.current?.contentWindow,
        data: event.data,
        userActive: hasRecentUserActivation(),
      });
      if (action?.kind === "resize") setReportedHeight(action.height);
      else if (action?.kind === "open-link") openExternalLink(action.url);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    // The page has an opaque origin, so "*" is the only target that reaches it.
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  }, [theme]);

  const height = fill ? undefined : htmlRenderFrameHeight(reference.height, reportedHeight);
  return src === null ? (
    <div
      className={fill ? "size-full" : "w-full animate-pulse rounded-md bg-muted/40"}
      style={fill ? undefined : { height }}
      aria-busy
    />
  ) : (
    <iframe
      ref={frameRef}
      src={src}
      title={reference.title}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      loading="lazy"
      className={fill ? "block size-full border-0" : "block w-full border-0"}
      style={fill ? undefined : { height }}
      onLoad={() =>
        frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*")
      }
    />
  );
}

/** The inline page in a reply, with a button that opens it full screen. */
export const HtmlRenderCard = memo(function HtmlRenderCard({
  environmentId,
  reference,
}: {
  environmentId: EnvironmentId;
  reference: HtmlRenderReference;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="min-w-0" data-html-render={reference.attachmentId}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="truncate text-[11px] font-medium text-muted-foreground">
          {reference.title}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Open full screen"
          onClick={() => setExpanded(true)}
        >
          <Maximize2Icon className="size-3" />
        </Button>
      </div>
      <HtmlRenderFrame environmentId={environmentId} reference={reference} />
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogPopup
          className="h-[min(90vh,1200px)] max-w-[min(96vw,1400px)] overflow-hidden p-0"
          bottomStickOnMobile={false}
        >
          <div className="flex h-10 shrink-0 items-center border-b px-4 pe-12">
            <DialogTitle className="truncate text-sm">{reference.title}</DialogTitle>
          </div>
          <div className="min-h-0 flex-1">
            {expanded ? (
              <HtmlRenderFrame environmentId={environmentId} reference={reference} fill />
            ) : null}
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
});
