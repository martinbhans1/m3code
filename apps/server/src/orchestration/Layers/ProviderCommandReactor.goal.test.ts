import { describe, expect, it } from "vite-plus/test";

import { withThreadGoal } from "./ProviderCommandReactor.ts";

describe("withThreadGoal", () => {
  it("sends the goal after the user's message", () => {
    const sent = withThreadGoal("Fix the slow ticket list", "Ticket list loads under a second");
    expect(sent?.startsWith("Fix the slow ticket list")).toBe(true);
    expect(sent).toContain(
      "<conversation_goal>\nTicket list loads under a second\n</conversation_goal>",
    );
  });

  it("leaves the message alone when there is no goal, and sends nothing for an empty turn", () => {
    expect(withThreadGoal("Hello", null)).toBe("Hello");
    expect(withThreadGoal("Hello", "   ")).toBe("Hello");
    expect(withThreadGoal(undefined, "A goal")).toBeUndefined();
  });
});
