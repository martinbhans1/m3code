/**
 * LaTeX maths in chat Markdown.
 *
 * `remark-math` owns `$$…$$` (inline and block). Single-dollar `$…$` and the
 * `\(…\)` / `\[…\]` delimiters models often emit are parsed here instead,
 * because the stock single-dollar rule turns prose like "costs $5 and $10" into
 * a formula. The single-dollar rule follows Pandoc, made stricter:
 *
 * - the opening `$` is not followed by whitespace,
 * - the first unescaped `$` after it is the only closing candidate; if that one
 *   is preceded by whitespace or followed by a digit, there is no formula,
 * - the formula stays on one line and never contains a backtick, `](` or `://`
 *   (a code span, a link destination or a URL started inside it).
 *
 * Both constructs emit the same tokens as `micromark-extension-math`, so
 * `mdast-util-math` turns them into ordinary `inlineMath` nodes.
 */
import type {
  Code,
  Construct,
  Effects,
  Extension,
  State,
  TokenizeContext,
} from "micromark-util-types";
import remarkMath from "remark-math";

// The token names `mdast-util-math` turns into `inlineMath` nodes.
declare module "micromark-util-types" {
  interface TokenTypeMap {
    mathText: "mathText";
    mathTextData: "mathTextData";
    mathTextSequence: "mathTextSequence";
  }
}

const DOLLAR = 36;
const BACKSLASH = 92;
const GRAVE = 96;
const LEFT_PAREN = 40;
const RIGHT_PAREN = 41;
const LEFT_BRACKET = 91;
const RIGHT_BRACKET = 93;
const COLON = 58;
const SLASH = 47;
const SPACE = 32;

// micromark encodes line endings as -5/-4/-3 and tabs/virtual spaces as -2/-1.
function isLineEnding(code: Code): boolean {
  return code !== null && code < -2;
}

function isWhitespace(code: Code): boolean {
  return code === null || code < 0 || code === SPACE;
}

function isDigit(code: Code): boolean {
  return code !== null && code >= 48 && code <= 57;
}

/** True when the characters so far start something that is not maths. */
function startsNonMath(beforePrevious: Code, previous: Code, code: Code): boolean {
  if (previous === RIGHT_BRACKET && code === LEFT_PAREN) return true;
  return beforePrevious === COLON && previous === SLASH && code === SLASH;
}

function tokenizeSingleDollarMath(
  this: TokenizeContext,
  effects: Effects,
  ok: State,
  nok: State,
): State {
  let previous: Code = null;
  let beforePrevious: Code = null;
  let inData = false;

  const consumeData = (code: Code) => {
    if (!inData) {
      effects.enter("mathTextData");
      inData = true;
    }
    effects.consume(code);
    beforePrevious = previous;
    previous = code;
  };

  const close: State = (code) => {
    // `$5-$10`: a closing dollar right before a digit is a price.
    if (isDigit(code) || code === DOLLAR) return nok(code);
    effects.exit("mathText");
    return ok(code);
  };

  const escaped: State = (code) => {
    if (code === null || isLineEnding(code)) return nok(code);
    consumeData(code);
    return data;
  };

  const data: State = (code) => {
    if (code === null || isLineEnding(code) || code === GRAVE) return nok(code);
    if (code === DOLLAR) {
      if (isWhitespace(previous)) return nok(code);
      effects.exit("mathTextData");
      inData = false;
      effects.enter("mathTextSequence");
      effects.consume(code);
      effects.exit("mathTextSequence");
      return close;
    }
    if (startsNonMath(beforePrevious, previous, code)) return nok(code);
    consumeData(code);
    return code === BACKSLASH ? escaped : data;
  };

  const open: State = (code) => {
    // `$$` belongs to remark-math; `$ 5` is prose.
    if (code === DOLLAR || isWhitespace(code)) return nok(code);
    return data(code);
  };

  return (code) => {
    effects.enter("mathText");
    effects.enter("mathTextSequence");
    effects.consume(code);
    effects.exit("mathTextSequence");
    return open;
  };
}

const singleDollarMath: Construct = {
  name: "chatSingleDollarMath",
  tokenize: tokenizeSingleDollarMath,
  // An escaped dollar may sit right before a formula: `\$$x$`.
  previous(code) {
    return code !== DOLLAR || this.events.at(-1)?.[1].type === "characterEscape";
  },
};

function tokenizeTexMath(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let closer: number = RIGHT_PAREN;
  let inData = false;
  // `\[1\]` and `\(2, 3\)` are escaped brackets far more often than maths.
  let substantive = false;

  const exitData = () => {
    if (!inData) return;
    effects.exit("mathTextData");
    inData = false;
  };

  const consumeData = (code: Code) => {
    if (!inData) {
      effects.enter("mathTextData");
      inData = true;
    }
    if (code !== BACKSLASH && code !== 44 && !isWhitespace(code) && !isDigit(code)) {
      substantive = true;
    }
    effects.consume(code);
  };

  const closeSequence: Construct = {
    partial: true,
    tokenize(closeEffects, closeOk, closeNok) {
      return (code) => {
        closeEffects.enter("mathTextSequence");
        closeEffects.consume(code);
        return (next) => {
          if (next !== closer) return closeNok(next);
          closeEffects.consume(next);
          closeEffects.exit("mathTextSequence");
          return closeOk;
        };
      };
    },
  };

  const afterClose: State = (code) => {
    if (!substantive) return nok(code);
    effects.exit("mathText");
    return ok(code);
  };

  const escaped: State = (code) => {
    if (code === null || isLineEnding(code)) return data(code);
    consumeData(code);
    return data;
  };

  const backslashInData: State = (code) => {
    consumeData(code);
    return escaped;
  };

  const data: State = (code) => {
    if (code === null || code === GRAVE) return nok(code);
    if (isLineEnding(code)) {
      // `\(…\)` stays on one line; `\[…\]` may span several.
      if (closer === RIGHT_PAREN) return nok(code);
      exitData();
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return data;
    }
    if (code === BACKSLASH) {
      exitData();
      return effects.attempt(closeSequence, afterClose, backslashInData)(code);
    }
    consumeData(code);
    return data;
  };

  const open: State = (code) => {
    if (code === LEFT_PAREN) closer = RIGHT_PAREN;
    else if (code === LEFT_BRACKET) closer = RIGHT_BRACKET;
    else return nok(code);
    effects.consume(code);
    effects.exit("mathTextSequence");
    return data;
  };

  return (code) => {
    effects.enter("mathText");
    effects.enter("mathTextSequence");
    effects.consume(code);
    return open;
  };
}

const texMath: Construct = {
  name: "chatTexMath",
  tokenize: tokenizeTexMath,
  // Before character escapes, which would otherwise read `\(` as a literal `(`.
  add: "before",
};

const chatMathSyntax: Extension = {
  text: { [DOLLAR]: singleDollarMath, [BACKSLASH]: texMath },
};

type MathAstNode = {
  type?: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hProperties?: Record<string, unknown>; hChildren?: unknown[] };
  children?: MathAstNode[];
};

const INLINE_DELIMITER_REGEX = /^(\$\$?|\\\(|\\\[)([\s\S]*?)(\$\$?|\\\)|\\\])$/;

/**
 * Inline formulas keep their authored TeX (line breaks included), and
 * `$$…$$` or `\[…\]` written inside a paragraph render as display maths.
 */
function finishInlineMath(tree: MathAstNode, source: string) {
  const visit = (node: MathAstNode) => {
    if (node.type === "inlineMath") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const match =
        start === undefined || end === undefined
          ? null
          : INLINE_DELIMITER_REGEX.exec(source.slice(start, end));
      if (match) {
        const tex = match[2]!.trim();
        const display = match[1] === "$$" || match[1] === "\\[";
        node.value = tex;
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            className: ["language-math", display ? "math-display" : "math-inline"],
          },
          hChildren: [{ type: "text", value: tex }],
        };
      }
      return;
    }
    node.children?.forEach(visit);
  };
  visit(tree);
}

/** Messages without any delimiter skip the post-parse walk entirely. */
export function mayContainMath(text: string): boolean {
  return text.includes("$") || text.includes("\\(") || text.includes("\\[");
}

type RemarkMathPlugin = typeof remarkMath;

/** remark plugin: chat maths (see the module comment for the delimiter rules). */
export const remarkChatMath = function remarkChatMath(this: {
  data(): { micromarkExtensions?: Extension[] };
}) {
  remarkMath.call(this as never, { singleDollarTextMath: false });
  const data = this.data();
  (data.micromarkExtensions ??= []).push(chatMathSyntax);
  return (tree: unknown, file: { value: unknown }) => {
    const source = String(file.value ?? "");
    if (mayContainMath(source)) finishInlineMath(tree as MathAstNode, source);
  };
} as unknown as RemarkMathPlugin;

/** Which kind of formula a `<code>` class list marks, if any. */
export function mathKind(className: string | undefined): "inline" | "display" | null {
  if (!className?.includes("language-math")) return null;
  if (className.includes("math-display")) return "display";
  return className.includes("math-inline") ? "inline" : null;
}
