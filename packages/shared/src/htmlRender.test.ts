import { describe, expect, it } from "vite-plus/test";

import {
  htmlRenderFrameHeight,
  htmlRenderPageKey,
  normalizeHtmlRenderKey,
  readHtmlRenderReference,
  injectHtmlRenderBootstrap,
  readHtmlRenderFrameMessage,
  readHtmlRenderFromToolData,
} from "./htmlRender.ts";

const result = { htmlRender: { attachmentId: "thread-1-abc", title: "Chart", height: 600 } };

describe("readHtmlRenderFromToolData", () => {
  it("reads Claude's namespaced tool result", () => {
    expect(
      readHtmlRenderFromToolData({
        toolName: "mcp__t3-code__html_render",
        input: { html: "<p>x</p>", title: "Chart" },
        result: {
          type: "tool_result",
          content: [{ type: "text", text: JSON.stringify(result) }],
          is_error: false,
        },
      }),
    ).toEqual({ attachmentId: "thread-1-abc", title: "Chart", height: 600 });
  });

  it("reads Codex's MCP item, structured or as text", () => {
    expect(
      readHtmlRenderFromToolData({
        item: { tool: "html_render", result: { structuredContent: result, content: [] } },
      })?.attachmentId,
    ).toBe("thread-1-abc");
    expect(
      readHtmlRenderFromToolData({
        item: {
          tool: "html_render",
          result: { content: [{ type: "text", text: JSON.stringify(result) }] },
        },
      })?.attachmentId,
    ).toBe("thread-1-abc");
  });

  it("ignores failed calls and other tools", () => {
    const content = [{ type: "text", text: JSON.stringify(result) }];
    expect(
      readHtmlRenderFromToolData({
        toolName: "mcp__t3-code__html_render",
        result: { content, is_error: true },
      }),
    ).toBeUndefined();
    expect(
      readHtmlRenderFromToolData({ toolName: "mcp__other__render", result: { content } }),
    ).toBeUndefined();
    expect(
      readHtmlRenderFromToolData({
        item: { tool: "html_render", error: { message: "nope" }, result: null },
      }),
    ).toBeUndefined();
    expect(readHtmlRenderFromToolData("not a record")).toBeUndefined();
  });

  it("clamps the height and falls back to a title", () => {
    expect(
      readHtmlRenderFromToolData({
        toolName: "html_render",
        result: {
          content: JSON.stringify({ htmlRender: { attachmentId: "a", title: " ", height: 9 } }),
        },
      }),
    ).toEqual({ attachmentId: "a", title: "HTML page", height: 80 });
  });
});

describe("page keys", () => {
  it("accepts a plain name and refuses anything that could not be one", () => {
    expect(normalizeHtmlRenderKey("  ticket-card.v2_final ")).toBe("ticket-card.v2_final");
    expect(normalizeHtmlRenderKey("has spaces")).toBeUndefined();
    expect(normalizeHtmlRenderKey("-leading-dash")).toBeUndefined();
    expect(normalizeHtmlRenderKey("")).toBeUndefined();
    expect(normalizeHtmlRenderKey("x".repeat(65))).toBeUndefined();
    expect(normalizeHtmlRenderKey(7)).toBeUndefined();
  });

  it("carries the key and the panel request, and drops a key it cannot use", () => {
    expect(
      readHtmlRenderReference({ attachmentId: "a", title: "T", key: "mockup", panel: true }),
    ).toEqual({ attachmentId: "a", title: "T", key: "mockup", panel: true });
    expect(
      readHtmlRenderReference({ attachmentId: "a", title: "T", key: "no good", panel: "yes" }),
    ).toEqual({ attachmentId: "a", title: "T" });
  });

  it("identifies a page by its key, or by itself when it has none", () => {
    expect(htmlRenderPageKey({ attachmentId: "a", title: "T", key: "mockup" })).toBe("key:mockup");
    expect(htmlRenderPageKey({ attachmentId: "a", title: "T" })).toBe("page:a");
    // A key spelled like an attachment id is still a different page.
    expect(htmlRenderPageKey({ attachmentId: "b", title: "T", key: "a" })).not.toBe(
      htmlRenderPageKey({ attachmentId: "a", title: "T" }),
    );
  });
});

describe("readHtmlRenderFrameMessage", () => {
  const link = (url: unknown) => ({
    jsonrpc: "2.0",
    id: "t3-link-1",
    method: "ui/open-link",
    params: { url },
  });

  it("accepts http(s) links and size reports", () => {
    expect(readHtmlRenderFrameMessage(link("https://example.com/a?b=1"))).toEqual({
      kind: "open-link",
      url: "https://example.com/a?b=1",
    });
    expect(
      readHtmlRenderFrameMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { height: 321 },
      }),
    ).toEqual({ kind: "size", height: 321 });
  });

  it("rejects every other scheme and malformed message", () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", 42]) {
      expect(readHtmlRenderFrameMessage(link(url)), String(url)).toBeUndefined();
    }
    expect(readHtmlRenderFrameMessage({ method: "ui/open-link" })).toBeUndefined();
    expect(
      readHtmlRenderFrameMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { height: Number.NaN },
      }),
    ).toBeUndefined();
  });
});

describe("htmlRenderFrameHeight", () => {
  it("starts at the agent's height, then follows the page up to that cap", () => {
    expect(htmlRenderFrameHeight(600, null)).toBe(600);
    expect(htmlRenderFrameHeight(undefined, null)).toBe(400);
    expect(htmlRenderFrameHeight(600, 300)).toBe(300);
    expect(htmlRenderFrameHeight(600, 900)).toBe(600);
    expect(htmlRenderFrameHeight(undefined, 5000)).toBe(2000);
    expect(htmlRenderFrameHeight(undefined, 10)).toBe(80);
  });
});

describe("injectHtmlRenderBootstrap", () => {
  it("goes first in the page's own head", () => {
    const page = injectHtmlRenderBootstrap(
      '<!doctype html><html><head><meta charset="utf-8"><style>p{}</style></head><body></body></html>',
    );
    expect(page.indexOf('id="t3-theme"')).toBeGreaterThan(page.indexOf("<head>"));
    expect(page.indexOf('id="t3-theme"')).toBeLessThan(page.indexOf("<style>p{}"));
    // The page already declares a charset.
    expect(page.match(/charset/g)).toHaveLength(1);
  });

  it("adds a head to a bare fragment", () => {
    const page = injectHtmlRenderBootstrap("<p>hi</p>");
    expect(page.startsWith("<!doctype html><head>")).toBe(true);
    expect(page.endsWith("<p>hi</p>")).toBe(true);
  });

  it("never lands inside a script or comment that mentions <head>", () => {
    const html = '<!-- <head> --><script>const s = "<head>";</script><html><head></head></html>';
    const page = injectHtmlRenderBootstrap(html);
    expect(page.startsWith('<!-- <head> --><script>const s = "<head>";</script><html><head>')).toBe(
      true,
    );
    expect(page.indexOf('id="t3-theme"')).toBeGreaterThan(page.indexOf("<html><head>"));
  });
});
