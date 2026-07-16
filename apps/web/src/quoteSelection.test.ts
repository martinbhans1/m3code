import { describe, expect, it } from "vite-plus/test";

import { buildQuoteInsertion, formatQuoteBlocksForDisplay } from "./quoteSelection";

describe("buildQuoteInsertion", () => {
  it("wraps the selection in quote tags on its own lines", () => {
    expect(buildQuoteInsertion("", "some selected text")).toBe(
      "<quote>\nsome selected text\n</quote>\n",
    );
  });

  it("returns null for empty or whitespace-only selections", () => {
    expect(buildQuoteInsertion("", "")).toBeNull();
    expect(buildQuoteInsertion("", "   \n\t  ")).toBeNull();
  });

  it("separates the quote from an existing draft with a newline", () => {
    expect(buildQuoteInsertion("draft in progress", "quoted")).toBe(
      "\n<quote>\nquoted\n</quote>\n",
    );
  });

  it("does not double up newlines when the draft already ends with one", () => {
    expect(buildQuoteInsertion("draft line\n", "quoted")).toBe("<quote>\nquoted\n</quote>\n");
  });

  it("normalizes CRLF line endings and trims the selection", () => {
    expect(buildQuoteInsertion("", "  first\r\nsecond\r\n")).toBe(
      "<quote>\nfirst\nsecond\n</quote>\n",
    );
  });

  it("preserves interior blank lines in multi-paragraph selections", () => {
    expect(buildQuoteInsertion("", "first paragraph\n\nsecond paragraph")).toBe(
      "<quote>\nfirst paragraph\n\nsecond paragraph\n</quote>\n",
    );
  });
});

describe("formatQuoteBlocksForDisplay", () => {
  it("returns text without quote tags unchanged", () => {
    const text = "just a normal message\nwith two lines";
    expect(formatQuoteBlocksForDisplay(text)).toBe(text);
  });

  it("converts a quote block into a markdown blockquote", () => {
    expect(formatQuoteBlocksForDisplay("<quote>\nquoted line\n</quote>\n")).toBe(
      "> quoted line\n\n",
    );
  });

  it("prefixes every line of a multi-line quote", () => {
    expect(formatQuoteBlocksForDisplay("<quote>\nfirst\nsecond\n</quote>\n")).toBe(
      "> first\n> second\n\n",
    );
  });

  it("keeps a blank line between the quote and trailing text", () => {
    expect(formatQuoteBlocksForDisplay("<quote>\nquoted\n</quote>\nfollow-up question")).toBe(
      "> quoted\n\nfollow-up question",
    );
  });

  it("separates the quote from preceding text on the same line", () => {
    expect(formatQuoteBlocksForDisplay("see this: <quote>\nquoted\n</quote>\n")).toBe(
      "see this: \n> quoted\n\n",
    );
  });

  it("converts multiple quote blocks independently", () => {
    expect(
      formatQuoteBlocksForDisplay("<quote>\none\n</quote>\nand\n<quote>\ntwo\n</quote>\ndone"),
    ).toBe("> one\n\nand\n> two\n\ndone");
  });

  it("leaves an unterminated quote tag alone", () => {
    const text = "<quote>\nnever closed";
    expect(formatQuoteBlocksForDisplay(text)).toBe(text);
  });

  it("handles inline quote tags without their own lines", () => {
    expect(formatQuoteBlocksForDisplay("<quote>compact</quote> after")).toBe("> compact\n\n after");
  });
});
