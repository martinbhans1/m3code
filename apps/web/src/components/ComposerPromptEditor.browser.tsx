import "../index.css";

import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  replaceTextRange,
} from "~/composer-logic";
import { buildQuoteInsertion } from "~/quoteSelection";

const QUOTE_SOURCE = "<quote>\nquoted line\n</quote>";
const QUOTED_PROMPT = `${QUOTE_SOURCE}\n`;

/**
 * Mirrors how ChatComposer drives the editor: the prompt string is the source
 * of truth and the collapsed cursor comes back through onChange.
 */
function QuoteEditorHarness(props: { initialValue: string; focusCursor: number }) {
  const [state, setState] = useState({
    value: props.initialValue,
    cursor: clampCollapsedComposerCursor(props.initialValue, props.focusCursor),
  });
  const editorRef = useRef<ComposerPromptEditorHandle>(null);

  return (
    <div>
      <button type="button" onClick={() => editorRef.current?.focusAt(props.focusCursor)}>
        focus composer
      </button>
      <ComposerPromptEditor
        value={state.value}
        cursor={state.cursor}
        terminalContexts={[]}
        skills={[]}
        disabled={false}
        placeholder="Ask anything"
        onRemoveTerminalContext={() => {}}
        onChange={(nextValue, nextCursor) => {
          setState({ value: nextValue, cursor: nextCursor });
        }}
        onPaste={() => {}}
        editorRef={editorRef}
      />
      <pre data-testid="prompt-value">{JSON.stringify(state.value)}</pre>
    </div>
  );
}

/**
 * Mirrors the select-to-quote path end to end: ChatView builds the insertion,
 * ChatComposer appends it at the end of the prompt and refocuses the editor at
 * the resulting cursor. Quoting twice in one draft goes through this same path.
 */
function QuoteInsertHarness() {
  const [state, setState] = useState({ value: "", cursor: 0 });
  const promptRef = useRef("");
  const editorRef = useRef<ComposerPromptEditorHandle>(null);

  const insertQuote = (text: string) => {
    const insertion = buildQuoteInsertion(promptRef.current, text);
    if (!insertion) return;
    const end = promptRef.current.length;
    const next = replaceTextRange(promptRef.current, end, end, insertion);
    const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
    promptRef.current = next.text;
    setState({ value: next.text, cursor: nextCursor });
    window.requestAnimationFrame(() => editorRef.current?.focusAt(nextCursor));
  };

  return (
    <div>
      <button type="button" onClick={() => insertQuote("first quoted line")}>
        quote one
      </button>
      <button type="button" onClick={() => insertQuote("second quoted line")}>
        quote two
      </button>
      <ComposerPromptEditor
        value={state.value}
        cursor={state.cursor}
        terminalContexts={[]}
        skills={[]}
        disabled={false}
        placeholder="Ask anything"
        onRemoveTerminalContext={() => {}}
        onChange={(nextValue, nextCursor) => {
          promptRef.current = nextValue;
          setState({
            value: nextValue,
            cursor: clampCollapsedComposerCursor(nextValue, nextCursor),
          });
        }}
        onPaste={() => {}}
        editorRef={editorRef}
      />
      <pre data-testid="prompt-value">{JSON.stringify(state.value)}</pre>
    </div>
  );
}

function quoteCards(): HTMLElement[] {
  return Array.from(
    page.getByTestId("composer-editor").element().querySelectorAll("[data-composer-quote-block]"),
  );
}

async function focusComposer() {
  await userEvent.click(page.getByRole("button", { name: "focus composer" }));
}

function promptValue(): string {
  const element = document.querySelector('[data-testid="prompt-value"]');
  return JSON.parse(element?.textContent ?? '""') as string;
}

describe("ComposerPromptEditor quote blocks", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a quote block as a quote card instead of raw tags", async () => {
    const screen = await render(
      <QuoteEditorHarness initialValue={QUOTED_PROMPT} focusCursor={1} />,
    );

    const card = page
      .getByTestId("composer-editor")
      .element()
      .querySelector("[data-composer-quote-block]");
    expect(card).not.toBeNull();
    expect(card?.textContent).toBe("quoted line");
    expect(page.getByTestId("composer-editor").element().textContent).not.toContain("<quote>");
    // The prompt itself still carries the tags — the model sees them verbatim.
    expect(promptValue()).toBe(QUOTED_PROMPT);

    await screen.unmount();
  });

  it("keeps the caret after the quote card so a follow-up can be typed below it", async () => {
    const screen = await render(
      <QuoteEditorHarness initialValue={QUOTED_PROMPT} focusCursor={1} />,
    );

    await focusComposer();
    // Caret sits directly after the card: two new lines, then the question.
    await userEvent.keyboard("{Shift>}{Enter}{Enter}{/Shift}");
    await userEvent.keyboard("what does this mean?");

    await expect.poll(promptValue).toBe(`${QUOTE_SOURCE}\n\nwhat does this mean?\n`);
    expect(
      page.getByTestId("composer-editor").element().querySelector("[data-composer-quote-block]"),
    ).not.toBeNull();

    await screen.unmount();
  });

  it("typing at the end of the prompt lands after the quote, not inside it", async () => {
    const screen = await render(
      <QuoteEditorHarness initialValue={QUOTED_PROMPT} focusCursor={Number.POSITIVE_INFINITY} />,
    );

    await focusComposer();
    await userEvent.keyboard("thoughts?");

    await expect.poll(promptValue).toBe(`${QUOTE_SOURCE}\nthoughts?`);

    await screen.unmount();
  });

  it("paints the smooth caret on the quote card's line, not back at the top", async () => {
    localStorage.setItem("t3code:smooth-caret", "on");
    try {
      const screen = await render(
        <QuoteEditorHarness initialValue={`hello\n${QUOTED_PROMPT}`} focusCursor={7} />,
      );

      await focusComposer();
      const editor = page.getByTestId("composer-editor").element();
      const card = editor.querySelector("[data-composer-quote-block]");
      const caret = document.querySelector(".composer-smooth-caret");
      expect(card).not.toBeNull();
      expect(caret).not.toBeNull();

      await expect.poll(() => (caret as HTMLElement).dataset.visible).toBe("true");
      // The caret is on the card's line — not parked back at the composer's top.
      await expect
        .poll(() => {
          const cardRect = (card as HTMLElement).getBoundingClientRect();
          const caretRect = (caret as HTMLElement).getBoundingClientRect();
          return caretRect.bottom > cardRect.top + 1 && caretRect.top < cardRect.bottom + 1;
        })
        .toBe(true);

      await screen.unmount();
    } finally {
      localStorage.removeItem("t3code:smooth-caret");
    }
  });

  it("paints the smooth caret on an empty line, not back at the top", async () => {
    localStorage.setItem("t3code:smooth-caret", "on");
    try {
      const screen = await render(<QuoteEditorHarness initialValue={"hello\n"} focusCursor={6} />);
      await focusComposer();
      const editor = page.getByTestId("composer-editor").element();
      const caret = document.querySelector(".composer-smooth-caret") as HTMLElement;
      await expect.poll(() => caret.dataset.visible).toBe("true");

      // The caret sits on the empty second line: below the first line's text,
      // and back at the left edge.
      const firstLine = editor.querySelector("[data-lexical-text]") as HTMLElement;
      await expect
        .poll(
          () => caret.getBoundingClientRect().top > firstLine.getBoundingClientRect().bottom - 2,
        )
        .toBe(true);
      await expect
        .poll(() =>
          Math.round(caret.getBoundingClientRect().left - firstLine.getBoundingClientRect().left),
        )
        .toBe(0);

      await screen.unmount();
    } finally {
      localStorage.removeItem("t3code:smooth-caret");
    }
  });

  it("keeps the smooth caret with the text after Shift+Enter", async () => {
    localStorage.setItem("t3code:smooth-caret", "on");
    try {
      const screen = await render(<QuoteEditorHarness initialValue={""} focusCursor={0} />);
      await focusComposer();
      await userEvent.keyboard("hello");
      await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
      await expect.poll(promptValue).toBe("hello\n");

      const editor = page.getByTestId("composer-editor").element();
      const caret = document.querySelector(".composer-smooth-caret") as HTMLElement;
      const firstLine = () => editor.querySelector("[data-lexical-text]") as HTMLElement;
      // The caret follows the text down instead of snapping back to the start.
      await expect
        .poll(() => caret.getBoundingClientRect().top > firstLine().getBoundingClientRect().top + 5)
        .toBe(true);

      // …and backspace still eats the line break the caret is sitting on.
      await userEvent.keyboard("{Backspace}");
      await expect.poll(promptValue).toBe("hello");
      await expect
        .poll(() =>
          Math.round(caret.getBoundingClientRect().top - firstLine().getBoundingClientRect().top),
        )
        .toBe(0);

      await screen.unmount();
    } finally {
      localStorage.removeItem("t3code:smooth-caret");
    }
  });

  it("types before a leading mention chip", async () => {
    const screen = await render(
      <QuoteEditorHarness initialValue={"@AGENTS.md tail"} focusCursor={0} />,
    );

    await focusComposer();
    await userEvent.keyboard("hi ");
    await expect.poll(promptValue).toBe("hi [AGENTS.md](AGENTS.md) tail");

    await screen.unmount();
  });

  it("drops the caret onto an empty line under a freshly inserted quote", async () => {
    localStorage.setItem("t3code:smooth-caret", "on");
    try {
      const screen = await render(<QuoteInsertHarness />);
      await userEvent.click(page.getByRole("button", { name: "quote one" }));
      await expect.poll(promptValue).toBe("<quote>\nfirst quoted line\n</quote>\n");

      const caret = document.querySelector(".composer-smooth-caret") as HTMLElement;
      await expect.poll(() => caret.dataset.visible).toBe("true");
      // The caret opens the line *below* the card — not painted on top of it,
      // which reads as "the quote swallowed my cursor".
      await expect
        .poll(
          () =>
            caret.getBoundingClientRect().top > quoteCards()[0]!.getBoundingClientRect().bottom - 1,
        )
        .toBe(true);

      // …and typing lands there, on its own line under the card.
      await userEvent.keyboard("what about this?");
      await expect.poll(promptValue).toBe("<quote>\nfirst quoted line\n</quote>\nwhat about this?");

      await screen.unmount();
    } finally {
      localStorage.removeItem("t3code:smooth-caret");
    }
  });

  it("stacks a second quote under the first with its own reply line", async () => {
    const screen = await render(<QuoteInsertHarness />);

    await userEvent.click(page.getByRole("button", { name: "quote one" }));
    await expect.poll(promptValue).toContain("first quoted line");
    await userEvent.keyboard("what about this?");

    await userEvent.click(page.getByRole("button", { name: "quote two" }));
    await expect.poll(promptValue).toContain("second quoted line");
    // The caret escapes the second card the same way it escapes the first.
    await userEvent.keyboard("and this?");

    await expect
      .poll(promptValue)
      .toBe(
        "<quote>\nfirst quoted line\n</quote>\nwhat about this?\n" +
          "<quote>\nsecond quoted line\n</quote>\nand this?",
      );
    expect(quoteCards()).toHaveLength(2);

    await screen.unmount();
  });

  it("removes the quote and the line break it inserted in one Backspace", async () => {
    const screen = await render(<QuoteInsertHarness />);

    await userEvent.click(page.getByRole("button", { name: "quote one" }));
    await expect.poll(promptValue).toBe("<quote>\nfirst quoted line\n</quote>\n");

    // From the empty line under the card, one press takes the whole quote —
    // eating the invisible line break first reads as Backspace doing nothing.
    await userEvent.keyboard("{Backspace}");
    await expect.poll(promptValue).toBe("");
    expect(quoteCards()).toHaveLength(0);

    await screen.unmount();
  });

  it("removes the quote when backspacing from the start of the line below it", async () => {
    const screen = await render(<QuoteInsertHarness />);

    await userEvent.click(page.getByRole("button", { name: "quote one" }));
    await expect.poll(promptValue).toBe("<quote>\nfirst quoted line\n</quote>\n");
    await userEvent.keyboard("reply");
    await userEvent.keyboard("{ArrowLeft}".repeat(5));

    await userEvent.keyboard("{Backspace}");
    await expect.poll(promptValue).toBe("reply");
    expect(quoteCards()).toHaveLength(0);

    await screen.unmount();
  });

  it("leaves the line break alone when backspacing under a mention chip", async () => {
    // Only quote cards swallow their trailing break — a chip followed by one
    // still takes two presses, the first of which joins the lines.
    const screen = await render(
      <QuoteEditorHarness initialValue={"@AGENTS.md\n"} focusCursor={Number.POSITIVE_INFINITY} />,
    );

    await focusComposer();
    await userEvent.keyboard("{Backspace}");
    await expect.poll(promptValue).toBe("[AGENTS.md](AGENTS.md)");

    await userEvent.keyboard("{Backspace}");
    await expect.poll(promptValue).toBe("");

    await screen.unmount();
  });

  it("steps over the quote card as a single unit and deletes it whole", async () => {
    const screen = await render(
      <QuoteEditorHarness initialValue={QUOTED_PROMPT} focusCursor={1} />,
    );

    await focusComposer();
    // One ArrowLeft steps over the entire card, not one character of markup.
    await userEvent.keyboard("{ArrowLeft}");
    await userEvent.keyboard("hi ");
    await expect.poll(promptValue).toBe(`hi ${QUOTED_PROMPT}`);

    await userEvent.keyboard("{ArrowRight}{Backspace}");
    await expect.poll(promptValue).toBe("hi \n");
    expect(
      page.getByTestId("composer-editor").element().querySelector("[data-composer-quote-block]"),
    ).toBeNull();

    await screen.unmount();
  });
});
