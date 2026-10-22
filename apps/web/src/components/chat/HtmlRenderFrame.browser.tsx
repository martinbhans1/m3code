import "../../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const { pageUrl } = vi.hoisted(() => ({ pageUrl: { current: "" } }));

vi.mock("../../assets/assetUrls", () => ({
  useAssetUrl: () => pageUrl.current,
}));

vi.mock("../../localApi", () => ({
  readLocalApi: () => null,
}));

import { HtmlRenderFrame } from "./HtmlRenderFrame";

describe("HtmlRenderFrame", () => {
  it("sandboxes the page and sizes the frame to the height the page reports", async () => {
    pageUrl.current = URL.createObjectURL(
      new Blob([injectHtmlRenderBootstrap('<div style="height:150px">chart</div>')], {
        type: "text/html",
      }),
    );
    const screen = await render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment-html-render")}
        reference={{ attachmentId: "thread-1-page", title: "Chart", height: 600 }}
      />,
    );

    try {
      const frame = document.querySelector("iframe")!;
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
      expect(frame.getAttribute("src")).toContain("#t3-theme=");
      // Starts at the agent's height, then shrinks to what the page reported.
      await vi.waitFor(() => expect(frame.style.height).toBe("150px"), { timeout: 5_000 });

      // Another window posting a size report is ignored.
      window.postMessage(
        { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 500 } },
        "*",
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(frame.style.height).toBe("150px");
    } finally {
      await screen.unmount();
      URL.revokeObjectURL(pageUrl.current);
    }
  });
});
