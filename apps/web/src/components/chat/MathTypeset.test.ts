import { describe, expect, it } from "vite-plus/test";

import { typesetMath } from "./MathTypeset";

describe("typesetMath", () => {
  it("typesets valid TeX", () => {
    expect(typesetMath("x^2", false)).toContain('class="katex"');
    expect(typesetMath("x^2", true)).toContain("katex-display");
  });

  it("returns nothing for an unfinished formula, so its source shows instead", () => {
    expect(typesetMath("\\frac{a}{", true)).toBe("");
  });

  it("never emits links, even when asked", () => {
    const html = typesetMath("\\href{https://example.com}{x}", false);
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).not.toContain("href=");
  });
});
