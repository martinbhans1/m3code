import "../index.css";

import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { DEFAULT_INTERACTION_MODE } from "../types";
import type { SidebarThreadSummary } from "../types";
import { SidebarThreadRow } from "./Sidebar";

vi.mock("~/hooks/useMediaQuery", () => ({
  useIsMobile: () => false,
  useMediaQuery: () => false,
}));

const THREAD_ID = ThreadId.make("thread-1");
const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");

function buildThread(hasPendingFollowups: boolean): SidebarThreadSummary {
  return {
    id: THREAD_ID,
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: "A thread",
    handoffThreadId: null,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    doneAt: null,
    updatedAt: undefined,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasPendingFollowups,
    hasActionableProposedPlan: false,
  };
}

function Harness({ hasPendingFollowups }: { hasPendingFollowups: boolean }) {
  const [renamingTitle, setRenamingTitle] = useState("");
  const [confirmingArchiveThreadKey, setConfirmingArchiveThreadKey] = useState<string | null>(null);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const renamingCommittedRef = useRef(false);
  const confirmArchiveButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  return (
    <AppAtomRegistryProvider>
      <ul>
        <SidebarThreadRow
          thread={buildThread(hasPendingFollowups)}
          projectCwd={null}
          orderedProjectThreadKeys={[]}
          isActive={false}
          jumpLabel={null}
          appSettingsConfirmThreadArchive={false}
          renamingThreadKey={null}
          renamingTitle={renamingTitle}
          setRenamingTitle={setRenamingTitle}
          startThreadRename={vi.fn()}
          renamingInputRef={renamingInputRef}
          renamingCommittedRef={renamingCommittedRef}
          confirmingArchiveThreadKey={confirmingArchiveThreadKey}
          setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
          confirmArchiveButtonRefs={confirmArchiveButtonRefs}
          handleThreadClick={vi.fn()}
          navigateToThread={vi.fn()}
          handleMultiSelectContextMenu={vi.fn(async () => {})}
          handleThreadContextMenu={vi.fn(async () => {})}
          clearSelection={vi.fn()}
          commitRename={vi.fn(async () => {})}
          cancelRename={vi.fn()}
          attemptArchiveThread={vi.fn(async () => {})}
          openPrLink={vi.fn()}
        />
      </ul>
    </AppAtomRegistryProvider>
  );
}

describe("SidebarThreadRow suggested-task indicator", () => {
  afterEach(() => {
    cleanup();
  });

  it("marks a thread that is holding a suggested task", async () => {
    render(<Harness hasPendingFollowups />);

    await expect.element(page.getByLabelText("Suggested task waiting")).toBeVisible();
  });

  it("stays clean when the thread has none", async () => {
    render(<Harness hasPendingFollowups={false} />);

    await expect.element(page.getByTestId(`thread-row-${THREAD_ID}`)).toBeVisible();
    expect(document.querySelectorAll('[aria-label="Suggested task waiting"]').length).toBe(0);
  });
});
