import { assert, describe, it } from "@effect/vitest";

import { projectToolServerMatchesPath } from "./projectToolServers.ts";

describe("projectToolServerMatchesPath", () => {
  it("offers a server to the project it was scoped to, and to work inside it", () => {
    const server = { projectPath: "C:/work/dealjourney" };

    assert.isTrue(projectToolServerMatchesPath(server, "C:/work/dealjourney"));
    // A worktree or subdirectory is still that project's conversation, and a
    // tool that vanished when someone opened a branch would look like a bug in
    // the tool rather than in the matching.
    assert.isTrue(projectToolServerMatchesPath(server, "C:/work/dealjourney/.worktrees/feature"));
    assert.isFalse(projectToolServerMatchesPath(server, "C:/work/other"));
    // Not a prefix match on the raw string: a sibling folder whose name merely
    // starts the same way is a different project.
    assert.isFalse(projectToolServerMatchesPath(server, "C:/work/dealjourney-marketing"));
  });

  it("treats the same folder spelled differently as the same folder", () => {
    const server = { projectPath: "C:\\work\\DealJourney\\" };

    // The same path reaches this code as backslashes from one caller and
    // forward slashes from another, with either casing on Windows. A tool that
    // silently failed to mount on one spelling would be near-impossible to see.
    assert.isTrue(projectToolServerMatchesPath(server, "c:/work/dealjourney"));
    assert.isTrue(projectToolServerMatchesPath(server, "C:\\work\\dealjourney\\packages\\web"));
  });

  it("offers an unscoped server everywhere, and a scoped one nowhere without a project", () => {
    assert.isTrue(projectToolServerMatchesPath({ projectPath: "" }, "C:/anything"));
    assert.isTrue(projectToolServerMatchesPath({ projectPath: "" }, null));
    // A conversation with no working directory cannot be shown to belong to the
    // scoped project, so it does not get the tool.
    assert.isFalse(projectToolServerMatchesPath({ projectPath: "C:/work/dealjourney" }, null));
    assert.isFalse(projectToolServerMatchesPath({ projectPath: "C:/work/dealjourney" }, ""));
  });
});
