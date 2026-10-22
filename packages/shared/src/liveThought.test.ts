import { describe, expect, it } from "vite-plus/test";

import { liveThoughtLine } from "./liveThought.ts";

describe("liveThoughtLine", () => {
  it("keeps the first sentence, including a closing quote", () => {
    expect(
      liveThoughtLine(
        'Found the cause: the repo has no commits, so `git worktree add` fails with "invalid reference: main." Now checking the UI.',
      ),
    ).toBe(
      'Found the cause: the repo has no commits, so git worktree add fails with "invalid reference: main."',
    );
  });

  it("does not cut at dots inside file names or long dashes", () => {
    expect(liveThoughtLine("I read ThreadLaunchService.ts — it skips the fetch. Next step.")).toBe(
      "I read ThreadLaunchService.ts — it skips the fetch.",
    );
  });

  it("uses a bold-only opening line as the whole line", () => {
    expect(
      liveThoughtLine("**Narrowing dispatch files**\n\nI should check the adapter. Then more."),
    ).toBe("Narrowing dispatch files");
    expect(liveThoughtLine("**Narrowing dispatch files**\r\n\r\nI should check the adapter.")).toBe(
      "Narrowing dispatch files",
    );
  });

  it("returns unpunctuated text whole and flattens markdown", () => {
    expect(liveThoughtLine("- Checking [the docs](https://x.dev) for **limits**")).toBe(
      "Checking the docs for limits",
    );
    expect(liveThoughtLine("This is *really* ~~not~~ _fine_ in snake_case_names.")).toBe(
      "This is really not fine in snake_case_names.",
    );
    expect(liveThoughtLine("   ")).toBe("");
  });
});
