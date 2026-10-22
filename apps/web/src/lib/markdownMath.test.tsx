import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { CHAT_MARKDOWN_SANITIZE_SCHEMA } from "./chatMarkdownSanitize";
import { mathKind, remarkChatMath } from "./markdownMath";

type Formula = [kind: "inline" | "display", tex: string];

/** Renders through the same remark/rehype chain as chat, and reads back the formulas. */
function render(markdown: string): { html: string; formulas: Formula[] } {
  const formulas: Formula[] = [];
  const html = renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkChatMath]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA]]}
      components={{
        code({ className, children }) {
          const kind = mathKind(className);
          if (kind) formulas.push([kind, String(children)]);
          return <code className={className}>{children}</code>;
        },
      }}
    >
      {markdown}
    </ReactMarkdown>,
  );
  return { html, formulas };
}

describe("chat maths parsing", () => {
  it("parses single-dollar, double-dollar and TeX-delimited formulas", () => {
    expect(render("Energy $E = mc^2$ here.").formulas).toEqual([["inline", "E = mc^2"]]);
    expect(render("Inline \\(a_i\\) too.").formulas).toEqual([["inline", "a_i"]]);
    expect(render("Shown $$x^2$$ big.").formulas).toEqual([["display", "x^2"]]);
    expect(render("\\[\n\\frac{a}{b}\n\\]").formulas).toEqual([["display", "\\frac{a}{b}"]]);
    expect(render("$$\n\\sum_i x_i\n$$").formulas).toEqual([["display", "\\sum_i x_i"]]);
  });

  it("keeps the line breaks of a multi-line display formula", () => {
    expect(render("\\[\na \\\\\nb\n\\]").formulas).toEqual([["display", "a \\\\\nb"]]);
  });

  it("keeps prices, shell variables and escaped brackets as prose", () => {
    for (const prose of [
      "It costs $5 and $10.",
      "Budget $5-$10 per seat, or $20,000-$30,000 a year.",
      "Plans are $5/$10 monthly.",
      "Run $browser then $deploy on it.",
      "Set $HOME before running.",
      "See note \\[1\\] and \\(2, 3\\).",
    ]) {
      const { formulas, html } = render(prose);
      expect(formulas, prose).toEqual([]);
      expect(html, prose).not.toContain("language-math");
    }
  });

  it("still finds a formula after a price on the same line", () => {
    for (const price of ["$5-$10", "$5 and $10", "$5/$10", "$20,000-$30,000"]) {
      const source = `Price ${price} stays literal. The formula is $x_i$ and $5$.`;
      expect(render(source).formulas, source).toEqual([
        ["inline", "x_i"],
        ["inline", "5"],
      ]);
    }
  });

  it("leaves code spans, links and URLs alone", () => {
    expect(render("Use `$x$` in code.").formulas).toEqual([]);
    expect(render("Export $PATH, then `$HOME`.").formulas).toEqual([]);
    const link = render(
      "Set $TOKEN, then open [users](https://graph.example.com/users?$select=id).",
    );
    expect(link.formulas).toEqual([]);
    expect(link.html).toContain('href="https://graph.example.com/users?$select=id"');
    expect(render("Open https://example.com/$a and $b$ later.").formulas).toEqual([
      ["inline", "b"],
    ]);
  });

  it("starts a formula right after an escaped dollar", () => {
    expect(render("Pay \\$$x$ now.").formulas).toEqual([["inline", "x"]]);
  });

  it("keeps the maths markers through the sanitizer and nothing else", () => {
    const { html } = render("$x$ and $$y$$");
    expect(html).toContain('class="language-math math-inline"');
    expect(html).toContain('class="language-math math-display"');
    expect(render('<code class="language-ts evil">x</code>').html).toContain('class="language-ts"');
  });
});

describe("mathKind", () => {
  it("reads the marker classes", () => {
    expect(mathKind("language-math math-inline")).toBe("inline");
    expect(mathKind("language-math math-display")).toBe("display");
    expect(mathKind("language-math")).toBeNull();
    expect(mathKind("language-ts")).toBeNull();
    expect(mathKind(undefined)).toBeNull();
  });
});
