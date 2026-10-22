import { lazy, memo, Suspense } from "react";

import { RenderErrorBoundary } from "../RenderErrorBoundary";

const MathTypeset = lazy(() => import("./MathTypeset"));

/**
 * One formula from chat Markdown. Shows its TeX until KaTeX loads, and keeps
 * showing it when KaTeX cannot parse it — an unfinished formula mid-stream.
 */
export const MarkdownMath = memo(function MarkdownMath(props: { tex: string; display: boolean }) {
  const tex = props.tex.trim();
  const source = props.display ? `\\[\n${tex}\n\\]` : `\\(${tex}\\)`;
  const fallback = <span className="whitespace-pre-wrap">{source}</span>;
  return (
    <span
      className={
        props.display
          ? "chat-markdown-math-display my-[0.65rem] block"
          : "inline-block max-w-full align-middle whitespace-nowrap"
      }
      data-markdown-math={props.display ? "display" : "inline"}
      role="group"
      aria-label={props.display ? "Display equation" : "Inline equation"}
    >
      <span
        className="block max-w-full overflow-x-auto overflow-y-hidden px-0.5 py-0.75"
        // Wide formulas scroll; the keyboard needs a stop to scroll them.
        tabIndex={props.display ? 0 : -1}
      >
        <span className={props.display ? "inline-block w-max min-w-full" : "inline-block w-max"}>
          <RenderErrorBoundary resetKeys={[tex]} fallback={fallback}>
            <Suspense fallback={fallback}>
              <MathTypeset tex={tex} display={props.display} fallback={fallback} />
            </Suspense>
          </RenderErrorBoundary>
        </span>
      </span>
    </span>
  );
});
