/**
 * Agent-authored HTML pages ("HTML renders"): a self-contained document an
 * agent shows inline in its thread with the `html_render` MCP tool. The server
 * stores each page as a thread attachment with a small bootstrap injected into
 * its head; the web client shows it in a sandboxed iframe, hands it the active
 * theme, and listens for the page's height and link requests.
 *
 * The page and its client talk JSON-RPC over postMessage, using the method
 * names of the MCP Apps protocol (https://github.com/modelcontextprotocol/ext-apps).
 */

export const HTML_RENDER_TOOL_NAME = "html_render";
/** Largest page the tool accepts, in UTF-8 bytes. */
export const HTML_RENDER_MAX_BYTES = 512 * 1024;
export const HTML_RENDER_MAX_TITLE_LENGTH = 200;
export const HTML_RENDER_MIN_HEIGHT = 80;
export const HTML_RENDER_MAX_HEIGHT = 2000;
/** The frame's height before the page reports its own, when the agent gave none. */
export const HTML_RENDER_DEFAULT_HEIGHT = 400;

export function clampHtmlRenderHeight(height: number): number {
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)));
}

/**
 * The inline frame's height: the page's own reported height once it has sent
 * one, never past the agent's cap; until then, the agent's height or a default.
 */
export function htmlRenderFrameHeight(
  agentHeight: number | undefined,
  reportedHeight: number | null,
): number {
  if (reportedHeight === null) {
    return clampHtmlRenderHeight(agentHeight ?? HTML_RENDER_DEFAULT_HEIGHT);
  }
  return clampHtmlRenderHeight(Math.min(reportedHeight, agentHeight ?? HTML_RENDER_MAX_HEIGHT));
}

/** What an `html_render` result carries so a client can show the page. */
export interface HtmlRenderReference {
  readonly attachmentId: string;
  readonly title: string;
  /** The most the frame may take, in CSS pixels; absent lets the page decide. */
  readonly height?: number;
}

export function readHtmlRenderReference(value: unknown): HtmlRenderReference | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const { attachmentId, title, height } = record;
  if (
    typeof attachmentId !== "string" ||
    attachmentId.length === 0 ||
    attachmentId.length > 256 ||
    typeof title !== "string"
  ) {
    return undefined;
  }
  return {
    attachmentId,
    title: title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML page",
    ...(typeof height === "number" && Number.isFinite(height)
      ? { height: clampHtmlRenderHeight(height) }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The structured result inside an MCP `content` array's first JSON text block. */
function structuredFromContent(content: unknown): Record<string, unknown> | undefined {
  if (typeof content === "string") return parseJsonRecord(content);
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === "text" && typeof record.text === "string") {
      const parsed = parseJsonRecord(record.text);
      if (parsed) return parsed;
    }
  }
  return undefined;
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function isHtmlRenderToolName(name: unknown): boolean {
  // Claude namespaces MCP tools as `mcp__<server>__<tool>`; Codex passes the bare name.
  return (
    typeof name === "string" &&
    (name === HTML_RENDER_TOOL_NAME || name.endsWith(`__${HTML_RENDER_TOOL_NAME}`))
  );
}

/**
 * The page a finished `html_render` call showed, read from a tool activity's
 * `data` — Codex's MCP tool item, or Claude's `{ toolName, result }`.
 */
export function readHtmlRenderFromToolData(data: unknown): HtmlRenderReference | undefined {
  const record = asRecord(data);
  if (!record) return undefined;
  const item = asRecord(record.item);
  if (item) {
    if (!isHtmlRenderToolName(item.tool) || item.error) return undefined;
    const result = asRecord(item.result);
    if (!result || result.isError === true) return undefined;
    const structured = asRecord(result.structuredContent) ?? structuredFromContent(result.content);
    return readHtmlRenderReference(structured?.htmlRender);
  }
  if (!isHtmlRenderToolName(record.toolName)) return undefined;
  const result = asRecord(record.result);
  if (!result || result.is_error === true || result.isError === true) return undefined;
  return readHtmlRenderReference(structuredFromContent(result.content)?.htmlRender);
}

// ── Page ↔ client messages ────────────────────────────────────────────

const HOST_CONTEXT_CHANGED_METHOD = "ui/notifications/host-context-changed";
const SIZE_CHANGED_METHOD = "ui/notifications/size-changed";
const OPEN_LINK_METHOD = "ui/open-link";

/** The resolved theme a client hands a page. */
export interface HtmlRenderTheme {
  readonly appearance: "light" | "dark";
  readonly variables: Readonly<Record<string, string>>;
}

/** The app's CSS variables a page can style against. */
export const HTML_RENDER_THEME_VARIABLES = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--border",
  "--input",
  "--ring",
  "--info",
  "--success",
  "--warning",
] as const;

/** What a page asked of its client, if `data` is one of its messages. */
export function readHtmlRenderFrameMessage(
  data: unknown,
):
  | { readonly kind: "size"; readonly height: number }
  | { readonly kind: "open-link"; readonly url: string }
  | undefined {
  const record = asRecord(data);
  if (!record || record.jsonrpc !== "2.0") return undefined;
  const params = asRecord(record.params);
  if (record.method === SIZE_CHANGED_METHOD) {
    const height = params?.height;
    return typeof height === "number" && Number.isFinite(height) && height >= 0
      ? { kind: "size", height }
      : undefined;
  }
  if (record.method === OPEN_LINK_METHOD) {
    const url = params?.url;
    if (typeof url !== "string" || url.length > 8192) return undefined;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:"
        ? { kind: "open-link", url: parsed.href }
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const THEME_FRAGMENT_KEY = "t3-theme";

/** URL fragment that hands a page its theme before first paint. */
export function htmlRenderThemeFragment(theme: HtmlRenderTheme): string {
  return `#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;
}

/** The notification a client posts into a mounted page when the theme changes. */
export function htmlRenderThemeMessage(theme: HtmlRenderTheme) {
  return {
    jsonrpc: "2.0",
    method: HOST_CONTEXT_CHANGED_METHOD,
    params: { theme: theme.appearance, styles: { variables: theme.variables } },
  } as const;
}

// ── The bootstrap injected into every stored page ─────────────────────

const LIGHT_DEFAULTS =
  "--background:#ffffff;--foreground:#171717;--card:#ffffff;--card-foreground:#171717;--popover:#ffffff;--popover-foreground:#171717;--primary:#171717;--primary-foreground:#fafafa;--secondary:#f5f5f5;--secondary-foreground:#171717;--muted:#f5f5f5;--muted-foreground:#737373;--accent:#f5f5f5;--accent-foreground:#171717;--destructive:#dc2626;--border:#e5e5e5;--input:#e5e5e5;--ring:#a3a3a3;--info:#3b82f6;--success:#10b981;--warning:#f59e0b";
const DARK_DEFAULTS =
  "--background:#0a0a0a;--foreground:#f5f5f5;--card:#171717;--card-foreground:#f5f5f5;--popover:#171717;--popover-foreground:#f5f5f5;--primary:#f5f5f5;--primary-foreground:#171717;--secondary:#262626;--secondary-foreground:#f5f5f5;--muted:#262626;--muted-foreground:#a3a3a3;--accent:#262626;--accent-foreground:#f5f5f5;--destructive:#ef4444;--border:#2e2e2e;--input:#2e2e2e;--ring:#525252;--info:#60a5fa;--success:#34d399;--warning:#fbbf24";

const BASE_CSS =
  "html{background:var(--background);color:var(--foreground);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.5;-webkit-text-size-adjust:100%}body{margin:0}";

// Runs synchronously in <head>, before the page's own styles, so the first
// paint is already themed. It rewrites its own <style> element, so a page's own
// `:root` rules still win, and drops the fragment so the page's hash routing
// never sees it. It reports the page's height whenever it changes, and turns a
// trusted click on an http(s) link into a request for the client to open it —
// the frame itself can neither navigate away nor open popups.
const BOOTSTRAP_SCRIPT = `(function(){var s=document.getElementById("t3-theme"),n=0,last=-1;var b=${JSON.stringify(BASE_CSS)};function post(m){if(window.parent!==window)window.parent.postMessage(m,"*");}function a(t){if(!s||!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"}"+b;}try{var m=/[#&]${THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash);if(m){a(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}}catch(e){}window.addEventListener("message",function(e){if(e.source!==window.parent)return;var d=e.data,p=d&&d.params;if(d&&d.jsonrpc==="2.0"&&d.method===${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}&&p&&p.styles)a({appearance:p.theme,variables:p.styles.variables});});function size(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);if(h!==last){last=h;post({jsonrpc:"2.0",method:${JSON.stringify(SIZE_CHANGED_METHOD)},params:{height:h}});}}if(typeof ResizeObserver==="function")new ResizeObserver(size).observe(document.documentElement);window.addEventListener("load",size);document.addEventListener("click",function(e){var l=e.isTrusted&&e.composedPath?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(u.href.split("#")[0]===location.href.split("#")[0])return;e.preventDefault();if(/^https?:$/.test(u.protocol))post({jsonrpc:"2.0",id:"t3-link-"+(++n),method:${JSON.stringify(OPEN_LINK_METHOD)},params:{url:u.href}});},true);})();`;

function bootstrapMarkup(head: string): string {
  const defaultCss = `:root{color-scheme:dark;${DARK_DEFAULTS}}@media (prefers-color-scheme: light){:root{color-scheme:light;${LIGHT_DEFAULTS}}}${BASE_CSS}`;
  return [
    /<meta\s[^>]*charset/i.test(head) ? "" : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(head)
      ? ""
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="t3-theme">${defaultCss}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
  ].join("");
}

// Comments and raw-text elements are blanked to the same length, so a `<head>`
// written inside a script or comment cannot receive the bootstrap.
const blankNonMarkup = (html: string) =>
  html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)/gi,
    (match) => " ".repeat(match.length),
  );

/** Inserts the bootstrap at the start of the document head, before the page's own styles and scripts. */
export function injectHtmlRenderBootstrap(html: string): string {
  const scan = blankNonMarkup(html);
  const markup = bootstrapMarkup(scan.slice(0, 8192));
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}
