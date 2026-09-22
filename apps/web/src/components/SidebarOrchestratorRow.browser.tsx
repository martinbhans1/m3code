import "../index.css";

import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";

import { SidebarOrchestratorRow } from "./SidebarOrchestratorRow";
import { SidebarProvider, useSidebar } from "./ui/sidebar";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const ORCHESTRATOR_PROJECT_ID = ProjectId.make("project-orchestrator");
const LATEST_THREAD_ID = ThreadId.make("orch-latest");
const EARLIER_THREAD_ID = ThreadId.make("orch-earlier");

const { openSpy, navigateSpy } = vi.hoisted(() => ({
  openSpy: vi.fn(async (_options?: { startFresh?: boolean }) => {}),
  navigateSpy: vi.fn(async () => {}),
}));

vi.mock("~/hooks/useMediaQuery", () => ({
  useIsMobile: () => true,
  useMediaQuery: () => true,
}));

vi.mock("../hooks/useOrchestratorConversation", () => ({
  useOpenOrchestratorConversation: () => openSpy,
  useOrchestratorProjectId: () => ORCHESTRATOR_PROJECT_ID,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
    useParams: ({ select }: { select?: (params: Record<string, never>) => unknown }) =>
      select ? select({}) : {},
  };
});

function orchestratorThread(overrides: Record<string, unknown>) {
  return {
    environmentId: ENVIRONMENT_ID,
    projectId: ORCHESTRATOR_PROJECT_ID,
    interactionMode: "build",
    session: null,
    createdAt: "2026-08-20T10:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    doneAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasPendingFollowups: false,
    hasActionableProposedPlan: false,
    handoffThreadId: null,
    ...overrides,
  };
}

const threadsRef: { current: ReadonlyArray<Record<string, unknown>> } = {
  current: [
    orchestratorThread({
      id: LATEST_THREAD_ID,
      title: "Plan the week",
      updatedAt: "2026-08-24T10:00:00.000Z",
    }),
    orchestratorThread({
      id: EARLIER_THREAD_ID,
      title: "Earlier chat",
      updatedAt: "2026-08-23T10:00:00.000Z",
    }),
  ],
};

vi.mock("../store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store")>();
  return {
    ...actual,
    useStore: () => threadsRef.current,
    selectSidebarThreadsAcrossEnvironments: () => threadsRef.current,
  };
});

function OpenMobileOnMount() {
  const { setOpenMobile } = useSidebar();
  useEffect(() => {
    setOpenMobile(true);
  }, [setOpenMobile]);
  return null;
}

function MobileSidebarProbe() {
  const { openMobile } = useSidebar();
  return <div data-testid="mobile-sidebar-open">{openMobile ? "open" : "closed"}</div>;
}

function Harness() {
  return (
    <SidebarProvider>
      <OpenMobileOnMount />
      <SidebarOrchestratorRow />
      <MobileSidebarProbe />
    </SidebarProvider>
  );
}

async function mountRow() {
  render(<Harness />);
  await expect.element(page.getByTestId("mobile-sidebar-open")).toHaveTextContent("open");
}

describe("SidebarOrchestratorRow on mobile", () => {
  afterEach(() => {
    cleanup();
    openSpy.mockClear();
    navigateSpy.mockClear();
    threadsRef.current = [
      orchestratorThread({
        id: LATEST_THREAD_ID,
        title: "Plan the week",
        updatedAt: "2026-08-24T10:00:00.000Z",
      }),
      orchestratorThread({
        id: EARLIER_THREAD_ID,
        title: "Earlier chat",
        updatedAt: "2026-08-23T10:00:00.000Z",
      }),
    ];
  });

  it("closes the sidebar sheet when the orchestrator row is tapped", async () => {
    await mountRow();

    await page.getByLabelText("Open the orchestrator conversation").click();

    expect(openSpy).toHaveBeenCalledWith({});
    await expect.element(page.getByTestId("mobile-sidebar-open")).toHaveTextContent("closed");
  });

  it("closes the sidebar sheet when starting a new orchestrator conversation", async () => {
    await mountRow();

    await page.getByLabelText("New orchestrator conversation").click();

    expect(openSpy).toHaveBeenCalledWith({ startFresh: true });
    await expect.element(page.getByTestId("mobile-sidebar-open")).toHaveTextContent("closed");
  });

  it("shows a dropdown of recent conversations instead of the thread list", async () => {
    await mountRow();

    await page.getByLabelText("Orchestrator conversations").click();

    const menu = page.getByRole("menu");
    await expect.element(menu).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "New conversation" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: /Plan the week/ })).toBeVisible();
    await expect.element(page.getByText("Recent")).toBeVisible();
  });

  it("closes the sidebar sheet when a recent orchestrator conversation is chosen", async () => {
    await mountRow();

    await page.getByLabelText("Orchestrator conversations").click();
    await page.getByRole("menuitem", { name: /Plan the week/ }).click();

    expect(navigateSpy).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: ENVIRONMENT_ID,
        threadId: LATEST_THREAD_ID,
      },
    });
    await expect.element(page.getByTestId("mobile-sidebar-open")).toHaveTextContent("closed");
  });

  it("shows on the row itself that the orchestrator is working", async () => {
    threadsRef.current = [
      orchestratorThread({
        id: LATEST_THREAD_ID,
        title: "Plan the week",
        updatedAt: "2026-08-24T10:00:00.000Z",
        // Fresh: a session that has been silent for an hour reads as stalled,
        // not as working, and a fixed date would drift into that.
        session: { status: "running", updatedAt: new Date().toISOString() },
      }),
    ];

    await mountRow();

    await expect.element(page.getByLabelText("Working")).toBeVisible();
  });

  it("shows an unread finished turn until the conversation is opened", async () => {
    threadsRef.current = [
      orchestratorThread({
        id: LATEST_THREAD_ID,
        title: "Plan the week",
        updatedAt: "2026-08-24T10:00:00.000Z",
        latestTurn: { completedAt: "2026-08-24T10:00:00.000Z" },
      }),
    ];

    await mountRow();

    await expect.element(page.getByLabelText("Completed")).toBeVisible();
  });

  it("ignores the state of conversations the row does not open", async () => {
    threadsRef.current = [
      orchestratorThread({
        id: LATEST_THREAD_ID,
        title: "Plan the week",
        updatedAt: "2026-08-24T10:00:00.000Z",
        latestTurn: { completedAt: "2026-08-24T10:00:00.000Z" },
      }),
      orchestratorThread({
        id: EARLIER_THREAD_ID,
        title: "Earlier chat",
        updatedAt: "2026-08-23T10:00:00.000Z",
        hasPendingUserInput: true,
        hasPendingFollowups: true,
      }),
    ];

    await mountRow();

    // The older conversation is the one waiting and holding the suggestion;
    // the row speaks only for the one a click would open.
    await expect.element(page.getByLabelText("Completed")).toBeVisible();
    expect(page.getByLabelText("Awaiting Input").elements()).toHaveLength(0);
    expect(page.getByLabelText("Suggested task waiting").elements()).toHaveLength(0);
  });

  it("shows each conversation's state in the dropdown", async () => {
    threadsRef.current = [
      orchestratorThread({
        id: LATEST_THREAD_ID,
        title: "Plan the week",
        updatedAt: "2026-08-24T10:00:00.000Z",
        latestTurn: { completedAt: "2026-08-24T10:00:00.000Z" },
      }),
      orchestratorThread({
        id: EARLIER_THREAD_ID,
        title: "Earlier chat",
        updatedAt: "2026-08-23T10:00:00.000Z",
        hasPendingUserInput: true,
      }),
    ];

    await mountRow();
    await page.getByLabelText("Orchestrator conversations").click();

    await expect.element(page.getByLabelText("Awaiting Input")).toBeVisible();
  });
});
