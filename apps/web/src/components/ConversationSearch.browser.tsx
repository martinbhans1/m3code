import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationSearchThreadsResult,
} from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { useState } from "react";
import { useConversationSearch } from "../hooks/useConversationSearch";

const { searchThreads } = vi.hoisted(() => ({ searchThreads: vi.fn() }));
vi.mock("../environmentApi", () => ({
  readEnvironmentApi: () => ({ orchestration: { searchThreads } }),
}));
const environmentIds = [EnvironmentId.make("local")];
const cutoff = "2026-09-08T00:00:00.000Z";
function Harness() {
  const [query, setQuery] = useState("deployment");
  const [recent, setRecent] = useState(false);
  const state = useConversationSearch({
    query,
    environmentIds,
    updatedSince: recent ? cutoff : null,
    enabled: true,
  });
  return (
    <>
      <input aria-label="Query" value={query} onChange={(event) => setQuery(event.target.value)} />
      <button onClick={() => setRecent(!recent)}>Recent</button>
      <div role="status">{state.pending ? "Searching" : state.failed ? "Failed" : "Done"}</div>
      {state.response?.results.map((result) => (
        <button key={result.threadId}>{result.title}</button>
      ))}
    </>
  );
}
function response(title: string): OrchestrationSearchThreadsResult {
  return {
    semanticStatus: "ready",
    results: [
      {
        threadId: ThreadId.make(title),
        projectId: ProjectId.make("p"),
        title,
        projectTitle: "Project",
        branch: null,
        archivedAt: null,
        updatedAt: cutoff,
        snippet: null,
        matchedRole: null,
        matchedMessageId: null,
        matchKind: "metadata",
        score: 1,
      },
    ],
  };
}
function pendingResponse() {
  let resolve!: (response: OrchestrationSearchThreadsResult) => void;
  const promise = new Promise<OrchestrationSearchThreadsResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  await cleanup();
  searchThreads.mockReset();
});

it("keeps loading visible until one combined response is ready", async () => {
  const pending = pendingResponse();
  searchThreads.mockReturnValue(pending.promise);
  await render(<Harness />);
  await expect.element(page.getByRole("status")).toHaveTextContent("Searching");
  await expect.poll(() => searchThreads.mock.calls.length).toBe(1);
  expect(searchThreads.mock.calls[0]?.[0]).toMatchObject({
    query: "deployment",
    includeSemantic: true,
  });
  pending.resolve(response("Final result"));
  await expect.element(page.getByRole("button", { name: "Final result" })).toBeVisible();
  await expect.element(page.getByRole("status")).toHaveTextContent("Done");
  expect(searchThreads).toHaveBeenCalledTimes(1);
});

it("hides old results when the date filter changes and ignores an obsolete query response", async () => {
  const old = pendingResponse();
  searchThreads.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response("Recent result"));
  await render(<Harness />);
  await expect.poll(() => searchThreads.mock.calls.length).toBe(1);
  await page.getByRole("button", { name: "Recent", exact: true }).click();
  await expect.poll(() => searchThreads.mock.calls.length).toBe(2);
  expect(searchThreads.mock.calls[1]?.[0]).toMatchObject({ updatedSince: cutoff });
  await expect.element(page.getByRole("button", { name: "Recent result" })).toBeVisible();
  old.resolve(response("Obsolete result"));
  await expect
    .element(page.getByRole("button", { name: "Obsolete result" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Recent result" })).toBeVisible();
  const next = pendingResponse();
  searchThreads.mockReturnValue(next.promise);
  await page.getByRole("textbox", { name: "Query" }).fill("another query");
  await expect.element(page.getByRole("button", { name: "Recent result" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("status")).toHaveTextContent("Searching");
});

it("ends loading with a failure instead of reporting no matches", async () => {
  searchThreads.mockRejectedValue(new Error("Disconnected"));
  await render(<Harness />);
  await expect.element(page.getByRole("status")).toHaveTextContent("Failed");
});
