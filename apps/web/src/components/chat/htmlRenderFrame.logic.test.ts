import { describe, expect, it } from "vite-plus/test";

import { resolveHtmlRenderFrameMessage } from "./htmlRenderFrame.logic";

const frameWindow = { name: "frame" };
const otherWindow = { name: "other" };
const size = { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 240 } };
const link = {
  jsonrpc: "2.0",
  id: "t3-link-1",
  method: "ui/open-link",
  params: { url: "https://example.com/" },
};

describe("resolveHtmlRenderFrameMessage", () => {
  it("acts on messages from its own frame", () => {
    expect(
      resolveHtmlRenderFrameMessage({
        source: frameWindow,
        frameWindow,
        data: size,
        userActive: false,
      }),
    ).toEqual({ kind: "resize", height: 240 });
    expect(
      resolveHtmlRenderFrameMessage({
        source: frameWindow,
        frameWindow,
        data: link,
        userActive: true,
      }),
    ).toEqual({ kind: "open-link", url: "https://example.com/" });
  });

  it("ignores any other window, and a frame that has not loaded", () => {
    for (const data of [size, link]) {
      expect(
        resolveHtmlRenderFrameMessage({ source: otherWindow, frameWindow, data, userActive: true }),
      ).toBeNull();
      expect(
        resolveHtmlRenderFrameMessage({ source: null, frameWindow: null, data, userActive: true }),
      ).toBeNull();
    }
  });

  it("opens a link only right after the reader interacted", () => {
    expect(
      resolveHtmlRenderFrameMessage({
        source: frameWindow,
        frameWindow,
        data: link,
        userActive: false,
      }),
    ).toBeNull();
  });
});
