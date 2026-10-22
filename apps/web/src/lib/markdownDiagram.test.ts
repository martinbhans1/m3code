import { describe, expect, it } from "vite-plus/test";

import { mermaidFenceView } from "./markdownDiagram";

describe("mermaidFenceView", () => {
  const code = "graph TD\n  A --> B";

  it("shows the source while the reply streams", () => {
    expect(mermaidFenceView({ code, isStreaming: true, showCode: false })).toBe("code");
  });

  it("draws the diagram once the reply settles", () => {
    expect(mermaidFenceView({ code, isStreaming: false, showCode: false })).toBe("diagram");
  });

  it("shows the source when the reader asks for it", () => {
    expect(mermaidFenceView({ code, isStreaming: false, showCode: true })).toBe("code");
  });

  it("never draws an empty fence", () => {
    expect(mermaidFenceView({ code: "  \n", isStreaming: false, showCode: false })).toBe("code");
  });
});
