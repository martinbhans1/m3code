import React, { type ReactNode } from "react";

interface RenderErrorBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
  /** A change in any of these clears a caught error and renders the children again. */
  resetKeys?: ReadonlyArray<unknown>;
}

interface RenderErrorBoundaryState {
  hasError: boolean;
  resetKeys: ReadonlyArray<unknown>;
}

const NO_RESET_KEYS: ReadonlyArray<unknown> = [];

function sameKeys(left: ReadonlyArray<unknown>, right: ReadonlyArray<unknown>): boolean {
  return left.length === right.length && left.every((key, index) => Object.is(key, right[index]));
}

/** Shows `fallback` instead of a subtree that threw while rendering. */
export class RenderErrorBoundary extends React.Component<
  RenderErrorBoundaryProps,
  RenderErrorBoundaryState
> {
  constructor(props: RenderErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, resetKeys: props.resetKeys ?? NO_RESET_KEYS };
  }

  static getDerivedStateFromError(): Partial<RenderErrorBoundaryState> {
    return { hasError: true };
  }

  static getDerivedStateFromProps(
    props: RenderErrorBoundaryProps,
    state: RenderErrorBoundaryState,
  ): Partial<RenderErrorBoundaryState> | null {
    const resetKeys = props.resetKeys ?? NO_RESET_KEYS;
    if (sameKeys(resetKeys, state.resetKeys)) return null;
    return { hasError: false, resetKeys };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}
