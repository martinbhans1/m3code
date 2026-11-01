import type { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildFollowupMenuActions, parseFollowupMenuEvent } from "./followupMenu";

const projectId = "project-1" as ProjectId;

describe("buildFollowupMenuActions", () => {
  it("offers a single start action in an ordinary conversation", () => {
    const [start] = buildFollowupMenuActions({ projectChoices: [], threadBusy: false });
    expect(start?.title).toBe("Start in new conversation");
    expect(start?.subactions).toBeUndefined();
  });

  it("makes the orchestrator name a real project", () => {
    const [start] = buildFollowupMenuActions({
      projectChoices: [{ id: projectId, title: "Dealy" }],
      threadBusy: false,
    });
    const choice = start?.subactions?.[0];
    expect(choice?.title).toBe("Dealy");
    expect(parseFollowupMenuEvent(choice?.id ?? "")).toEqual({ kind: "start", projectId });
  });

  it("blocks doing the task here while the conversation is running", () => {
    const actions = buildFollowupMenuActions({ projectChoices: [], threadBusy: true });
    expect(actions[1]?.attributes?.disabled).toBe(true);
  });
});

describe("parseFollowupMenuEvent", () => {
  it("round-trips the fixed actions and ignores anything else", () => {
    const [start, here, dismiss] = buildFollowupMenuActions({
      projectChoices: [],
      threadBusy: false,
    });
    expect(parseFollowupMenuEvent(start?.id ?? "")).toEqual({ kind: "start", projectId: null });
    expect(parseFollowupMenuEvent(here?.id ?? "")).toEqual({ kind: "here" });
    expect(parseFollowupMenuEvent(dismiss?.id ?? "")).toEqual({ kind: "dismiss" });
    expect(parseFollowupMenuEvent("unknown")).toBeNull();
  });
});
