import { describe, expect, it } from "vite-plus/test";

import { fileBasename, isMarkdownFilePath, resolveThreadFileReadTarget } from "./threadFileTarget";

describe("resolveThreadFileReadTarget", () => {
  it("reads relative links from the conversation's folder", () => {
    expect(
      resolveThreadFileReadTarget({
        target: "./apps/web/src/index.ts:42:7",
        threadCwd: "C:\\repo",
        knownRoots: [],
      }),
    ).toEqual({ cwd: "C:\\repo", relativePath: "apps/web/src/index.ts", line: 42 });
    expect(
      resolveThreadFileReadTarget({
        target: ".\\docs\\PLAN.md",
        threadCwd: "C:\\repo",
        knownRoots: [],
      }),
    ).toEqual({ cwd: "C:\\repo", relativePath: "docs\\PLAN.md", line: null });
  });

  it("reads an absolute link from the project that owns it, preferring the deepest root", () => {
    expect(
      resolveThreadFileReadTarget({
        target: "C:\\Users\\M\\GitHub\\other\\.worktrees\\a\\docs\\PLAN.md",
        threadCwd: "C:\\Users\\M\\GitHub\\repo",
        knownRoots: ["C:\\Users\\M\\GitHub\\other", "C:\\Users\\M\\GitHub\\other\\.worktrees\\a"],
      }),
    ).toEqual({
      cwd: "C:\\Users\\M\\GitHub\\other\\.worktrees\\a",
      relativePath: "docs/PLAN.md",
      line: null,
    });
  });

  it("reads a file outside every project from its own folder", () => {
    expect(
      resolveThreadFileReadTarget({
        target: "/tmp/claude/plan.txt:3",
        threadCwd: "/home/m/repo",
        knownRoots: ["/home/m/other"],
      }),
    ).toEqual({ cwd: "/tmp/claude", relativePath: "plan.txt", line: 3 });
    expect(
      resolveThreadFileReadTarget({ target: "C:\\notes.md", threadCwd: null, knownRoots: [] }),
    ).toEqual({ cwd: "C:\\", relativePath: "notes.md", line: null });
    expect(
      resolveThreadFileReadTarget({ target: "/notes.md", threadCwd: null, knownRoots: [] }),
    ).toEqual({ cwd: "/", relativePath: "notes.md", line: null });
  });

  it("gives up on links it cannot place", () => {
    expect(
      resolveThreadFileReadTarget({ target: "~/notes.md", threadCwd: "/repo", knownRoots: [] }),
    ).toBeNull();
    expect(
      resolveThreadFileReadTarget({ target: "src/a.ts", threadCwd: null, knownRoots: [] }),
    ).toBeNull();
  });
});

describe("file name helpers", () => {
  it("strips folders and line suffixes", () => {
    expect(fileBasename("C:\\repo\\README.md:10")).toBe("README.md");
    expect(isMarkdownFilePath("docs/plan.MD:4")).toBe(true);
    expect(isMarkdownFilePath("docs/plan.txt")).toBe(false);
  });
});
