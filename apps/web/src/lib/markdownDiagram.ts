/** The fence language drawn as a diagram rather than highlighted. */
export const MERMAID_FENCE_LANGUAGE = "mermaid";

/**
 * What a ```mermaid fence shows. A reply still streaming keeps the highlighted
 * source — a half-written diagram would re-layout on every token — and the
 * reader can flip a settled one back to its source.
 */
export function mermaidFenceView(input: {
  code: string;
  isStreaming: boolean;
  showCode: boolean;
}): "diagram" | "code" {
  if (input.isStreaming || input.showCode || input.code.trim().length === 0) return "code";
  return "diagram";
}
