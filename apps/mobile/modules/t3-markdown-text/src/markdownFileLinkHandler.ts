import { createContext, useContext } from "react";

/**
 * Receives the path of a file link the reader tapped, exactly as the message
 * wrote it (including any `:line` suffix). Without a provider, file chips are
 * not tappable.
 */
export type MarkdownFileLinkHandler = (target: string) => void;

const MarkdownFileLinkHandlerContext = createContext<MarkdownFileLinkHandler | null>(null);

export const MarkdownFileLinkHandlerProvider = MarkdownFileLinkHandlerContext.Provider;

export function useMarkdownFileLinkHandler(): MarkdownFileLinkHandler | null {
  return useContext(MarkdownFileLinkHandlerContext);
}
