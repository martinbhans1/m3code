import { TurnId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectLiveThoughtText, useLiveThoughtStore } from "./liveThoughtStore";

const threadKey = "env-1:thread-1";
const turn1 = TurnId.make("turn-1");
const thought = { turnId: turn1, text: "Checking the cache.", updatedAt: "2026-01-01T00:00:00Z" };

describe("liveThoughtStore", () => {
  beforeEach(() => {
    useLiveThoughtStore.setState({ byThreadKey: {} });
  });

  it("shows a thought only for the turn it belongs to", () => {
    useLiveThoughtStore.getState().setLiveThought(threadKey, thought);
    const state = useLiveThoughtStore.getState();
    expect(selectLiveThoughtText(state, threadKey, turn1)).toBe("Checking the cache.");
    expect(selectLiveThoughtText(state, threadKey, TurnId.make("turn-2"))).toBeNull();
    expect(selectLiveThoughtText(state, threadKey, null)).toBeNull();
    expect(selectLiveThoughtText(state, "env-1:other", turn1)).toBeNull();
  });

  it("keeps state identity for a repeated thought and clears on null", () => {
    const { setLiveThought } = useLiveThoughtStore.getState();
    setLiveThought(threadKey, thought);
    const before = useLiveThoughtStore.getState().byThreadKey;
    setLiveThought(threadKey, { ...thought, updatedAt: "2026-01-01T00:00:01Z" });
    expect(useLiveThoughtStore.getState().byThreadKey).toBe(before);

    setLiveThought(threadKey, null);
    expect(useLiveThoughtStore.getState().byThreadKey).toEqual({});
  });
});
