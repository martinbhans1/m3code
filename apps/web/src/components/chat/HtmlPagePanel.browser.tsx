import "../../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page as browserPage } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

vi.mock("../../assets/assetUrls", () => ({
  // One document per stored file, so the frame's address says which version is up.
  useAssetUrl: (_environmentId: unknown, asset: { attachmentId: string }) =>
    `data:text/html,${asset.attachmentId}`,
}));

vi.mock("../../localApi", () => ({
  readLocalApi: () => null,
}));

import type { HtmlPageState, HtmlRenderState } from "../../session-logic";
import { HtmlPagePanel, HtmlPagesPanel } from "./HtmlPagePanel";

const environmentId = EnvironmentId.make("environment-html-page");

function version(number: number, of: number, title: string): HtmlRenderState {
  return {
    id: `html-render:mockup-${number}`,
    createdAt: `2026-01-01T00:00:0${number}Z`,
    turnId: null,
    reference: { attachmentId: `file-${number}`, title, key: "mockup" },
    pageKey: "key:mockup",
    version: number,
    latest: number === of,
  };
}

const mockup: HtmlPageState = {
  pageKey: "key:mockup",
  title: "Mockup, final",
  versions: [
    version(1, 3, "Mockup"),
    version(2, 3, "Mockup, tighter"),
    version(3, 3, "Mockup, final"),
  ],
};

const shownFile = () => document.querySelector("iframe")?.getAttribute("src")?.split("#")[0];

describe("HtmlPagePanel", () => {
  it("shows the newest version and steps back through the earlier ones", async () => {
    const onSelectVersion = vi.fn();
    const screen = await render(
      <HtmlPagePanel
        environmentId={environmentId}
        page={mockup}
        fallbackTitle="Mockup"
        pinnedVersion={null}
        onSelectVersion={onSelectVersion}
        onShowAllPages={() => undefined}
      />,
    );

    try {
      await expect.element(browserPage.getByText("Version 3 of 3")).toBeVisible();
      expect(shownFile()).toBe("data:text/html,file-3");
      await expect
        .element(browserPage.getByRole("button", { name: "Later version" }))
        .toBeDisabled();

      await browserPage.getByRole("button", { name: "Earlier version" }).click();
      expect(onSelectVersion).toHaveBeenLastCalledWith(2);

      await screen.rerender(
        <HtmlPagePanel
          environmentId={environmentId}
          page={mockup}
          fallbackTitle="Mockup"
          pinnedVersion={2}
          onSelectVersion={onSelectVersion}
          onShowAllPages={() => undefined}
        />,
      );
      await expect.element(browserPage.getByText("Version 2 of 3")).toBeVisible();
      await expect.element(browserPage.getByText("Mockup, tighter")).toBeVisible();
      expect(shownFile()).toBe("data:text/html,file-2");

      // Stepping onto the newest goes back to following revisions, not pinning.
      await browserPage.getByRole("button", { name: "Later version" }).click();
      expect(onSelectVersion).toHaveBeenLastCalledWith(null);
      await browserPage.getByRole("button", { name: "Newest" }).click();
      expect(onSelectVersion).toHaveBeenLastCalledWith(null);
    } finally {
      await screen.unmount();
    }
  });

  it("says so when the page is not in the loaded conversation", async () => {
    const screen = await render(
      <HtmlPagePanel
        environmentId={environmentId}
        page={null}
        fallbackTitle="Old mockup"
        pinnedVersion={null}
        onSelectVersion={() => undefined}
        onShowAllPages={() => undefined}
      />,
    );
    try {
      await expect.element(browserPage.getByText("Old mockup")).toBeVisible();
      expect(document.querySelector("iframe")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});

describe("HtmlPagesPanel", () => {
  it("lists every page, most recently changed first, and opens the one clicked", async () => {
    const chart: HtmlPageState = {
      pageKey: "page:file-9",
      title: "Revenue chart",
      versions: [
        {
          id: "html-render:chart",
          createdAt: "2026-01-01T00:00:02Z",
          turnId: null,
          reference: { attachmentId: "file-9", title: "Revenue chart" },
          pageKey: "page:file-9",
          version: 1,
          latest: true,
        },
      ],
    };
    const onOpenPage = vi.fn();
    const screen = await render(<HtmlPagesPanel pages={[chart, mockup]} onOpenPage={onOpenPage} />);

    try {
      const rows = [...document.querySelectorAll("[data-html-pages-list] li")].map(
        (row) => row.textContent ?? "",
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]).toContain("Mockup, final");
      expect(rows[0]).toContain("3 versions");
      expect(rows[1]).toContain("Revenue chart");
      expect(rows[1]).not.toContain("versions");

      await browserPage.getByRole("button", { name: /Revenue chart/ }).click();
      expect(onOpenPage).toHaveBeenCalledWith(chart);
    } finally {
      await screen.unmount();
    }
  });

  it("explains itself when there are no pages", async () => {
    const screen = await render(<HtmlPagesPanel pages={[]} onOpenPage={() => undefined} />);
    try {
      await expect.element(browserPage.getByText("No pages yet")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
