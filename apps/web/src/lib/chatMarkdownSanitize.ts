import type rehypeSanitize from "rehype-sanitize";
import { defaultSchema } from "rehype-sanitize";

/** What survives `rehype-sanitize` in rendered chat Markdown. */
export const CHAT_MARKDOWN_SANITIZE_SCHEMA: NonNullable<Parameters<typeof rehypeSanitize>[0]> = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    // Fence languages plus the two maths markers `remark-math` puts on `<code>`.
    code: [["className", /^language-./, "math-inline", "math-display"], "dataCodeMeta"],
    // Where a workspace file href is kept so the sanitizer does not eat it —
    // see `rehypePreserveFileHrefs`.
    a: [...(defaultSchema.attributes?.a ?? []), "dataFileHref"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
  },
};
