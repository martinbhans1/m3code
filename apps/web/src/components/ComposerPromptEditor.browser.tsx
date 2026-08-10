import "../index.css";

import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { clampCollapsedComposerCursor } from "~/composer-logic";

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
