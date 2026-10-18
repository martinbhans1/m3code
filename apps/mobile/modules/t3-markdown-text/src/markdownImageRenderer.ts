import { createContext, useContext, type ReactNode } from "react";

export interface MarkdownImageRenderInput {
  readonly href: string;
  readonly alt: string | null;
}

/**
 * Lets the app take over how markdown images draw — for instance, to swap a
 * path on the server's disk for a URL the phone can actually load. Returning
 * `undefined` keeps the default image.
 */
export type MarkdownImageRenderer = (input: MarkdownImageRenderInput) => ReactNode | undefined;

const MarkdownImageRendererContext = createContext<MarkdownImageRenderer | null>(null);

export const MarkdownImageRendererProvider = MarkdownImageRendererContext.Provider;

export function useMarkdownImageRenderer(): MarkdownImageRenderer | null {
  return useContext(MarkdownImageRendererContext);
}
