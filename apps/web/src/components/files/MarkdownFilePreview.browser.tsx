import "../../index.css";

import { EnvironmentId, ThreadId, type EnvironmentApi } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

const { readFileMock, writeFileMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(async () => undefined),
}));

// The app supplies its shared syntax worker pool at startup. This isolated
// panel test uses the same editor with highlighting on the main thread.
vi.mock("@pierre/diffs/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@pierre/diffs/react")>();
  return {
    ...original,
    File: (props: Parameters<typeof original.File>[0]) => (
      <original.File {...props} disableWorkerPool />
    ),
  };
});

import FilePreviewPanel from "./FilePreviewPanel";
import { isMacPlatform } from "~/lib/utils";
import { getOptimisticProjectFileQueryData } from "./projectFilesQueryState";
import {
  __setEnvironmentApiOverrideForTests,
  __resetEnvironmentApiOverridesForTests,
} from "~/environmentApi";
import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "~/rpc/atomRegistry";

const environmentId = EnvironmentId.make("markdown-preview-test");
const threadRef = { environmentId, threadId: ThreadId.make("markdown-preview-thread") };
const contents = "# A readable guide\n\nSome **important** instructions.\n\n- [ ] Read only task\n";
function panel(
  relativePath: string,
  revealRequestId = 1,
  revealLine: number | null = null,
  cwd = "/repo",
) {
  return (
    <AppAtomRegistryProvider>
      <div style={{ display: "flex", height: 600, width: 800 }}>
        <FilePreviewPanel
          environmentId={environmentId}
          cwd={cwd}
          projectName="repo"
          relativePath={relativePath}
          threadRef={threadRef}
          composerDraftTarget={threadRef}
          keybindings={[]}
          availableEditors={[]}
          revealLine={revealLine}
          revealRequestId={revealRequestId}
          onOpenFile={() => {}}
          onPendingChange={() => {}}
        />
      </div>
    </AppAtomRegistryProvider>
  );
}
async function editorContent() {
  return vi.waitFor(() => {
    const element = document
      .querySelector("diffs-container")
      ?.shadowRoot?.querySelector<HTMLElement>('[contenteditable="true"]');
    expect(element).toBeTruthy();
    return element!;
  });
}

describe("Markdown file reading and editing", () => {
  beforeEach(() => {
    resetAppAtomRegistryForTests();
    __setEnvironmentApiOverrideForTests(environmentId, {
      projects: { readFile: readFileMock, writeFile: writeFileMock },
    } as unknown as EnvironmentApi);
    localStorage.setItem("t3code.fileExplorerOpen", "false");
    readFileMock.mockImplementation(async ({ relativePath }: { relativePath: string }) => ({
      relativePath,
      contents,
      byteLength: contents.length,
      truncated: false,
    }));
  });
  afterEach(() => {
    vi.clearAllMocks();
    __resetEnvironmentApiOverridesForTests();
    localStorage.clear();
  });

  it("opens formatted and read-only, edits the source, and returns to reading without losing changes", async () => {
    const screen = await render(panel("reading-editing.md"));
    try {
      await expect.element(page.getByRole("heading", { name: "A readable guide" })).toBeVisible();
      await expect.element(page.getByRole("checkbox")).toBeDisabled();
      expect(document.querySelector("diffs-container")).toBeNull();
      expect(writeFileMock).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Edit markdown", exact: true }).click();
      const editable = await editorContent();
      expect(editable.textContent).toContain("# A readable guide");
      editable.focus();
      await userEvent.keyboard(
        isMacPlatform(navigator.platform) ? "{Meta>}a{/Meta}" : "{Control>}a{/Control}",
      );
      await userEvent.keyboard("# Edited guide");
      await vi.waitFor(() =>
        expect(
          getOptimisticProjectFileQueryData(environmentId, "/repo", "reading-editing.md")?.contents,
        ).toBe("# Edited guide"),
      );
      await page.getByRole("button", { name: "Read markdown", exact: true }).click();

      await expect.element(page.getByRole("heading", { name: "Edited guide" })).toBeVisible();
      await vi.waitFor(() =>
        expect(writeFileMock).toHaveBeenCalledWith(
          expect.objectContaining({
            relativePath: "reading-editing.md",
            contents: expect.stringContaining("# Edited guide"),
          }),
        ),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("opens line links and newly selected Markdown files in reading mode", async () => {
    const screen = await render(panel("line-links.md", 1, 3));
    try {
      await expect.element(page.getByRole("heading", { name: "A readable guide" })).toBeVisible();
      await page.getByRole("button", { name: "Edit markdown", exact: true }).click();
      await editorContent();
      await screen.rerender(panel("second-file.md"));
      await expect.element(page.getByRole("heading", { name: "A readable guide" })).toBeVisible();
      expect(document.querySelector("diffs-container")).toBeNull();
      await screen.rerender(panel("line-links.md", 2, 3));
      await expect
        .element(page.getByRole("button", { name: "Edit markdown", exact: true }))
        .toBeVisible();
      expect(document.querySelector("diffs-container")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps truncated Markdown readable and prevents editing partial files", async () => {
    readFileMock.mockImplementation(async ({ relativePath }: { relativePath: string }) => ({
      relativePath,
      contents,
      byteLength: 2_000_000,
      truncated: true,
    }));
    const screen = await render(panel("truncated.md"));
    try {
      await expect.element(page.getByRole("heading", { name: "A readable guide" })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Edit markdown", exact: true }))
        .toBeDisabled();
      expect(writeFileMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
