/**
 * Thread tag vocabulary rules, shared by the server (which enforces them when
 * an agent tags a thread) and the clients (which filter and manage tags).
 *
 * The whole point of tags is that one area of the product gets exactly one
 * name. These helpers make the mechanical variants of a name collapse to the
 * same thing ("Tickets", "ticket", "tickets_page" → one key), and refuse a new
 * tag that is only a spelling variant of an existing one. Semantic synonyms
 * ("support" vs "tickets") cannot be caught here; the tag descriptions and the
 * agent brief carry that load, and the user can merge two tags afterwards.
 */
import type { ProjectThreadTag } from "@t3tools/contracts";

export const THREAD_TAG_MAX_LENGTH = 32;
export const THREAD_TAG_MAX_PER_THREAD = 4;
export const THREAD_GOAL_MAX_LENGTH = 600;

/** Lower-case kebab slug: "Opportunity Detail" → "opportunity-detail". */
export function normalizeThreadTagName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_/.]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, THREAD_TAG_MAX_LENGTH)
    .replace(/-$/, "");
}

/**
 * Comparison key that ignores separators and a trailing plural, so
 * "tickets", "ticket" and "tick-et" all collide. Only ever used to detect
 * near-duplicates, never stored.
 */
export function threadTagMatchKey(name: string): string {
  const compact = normalizeThreadTagName(name).replace(/-/g, "");
  if (compact.endsWith("ies") && compact.length > 4) return `${compact.slice(0, -3)}y`;
  if (compact.endsWith("s") && !compact.endsWith("ss") && compact.length > 3) {
    return compact.slice(0, -1);
  }
  return compact;
}

/** The existing vocabulary entry a name is a variant of, if any. */
export function findMatchingThreadTag(
  vocabulary: ReadonlyArray<ProjectThreadTag>,
  name: string,
): ProjectThreadTag | undefined {
  const key = threadTagMatchKey(name);
  if (key.length === 0) return undefined;
  return vocabulary.find((tag) => threadTagMatchKey(tag.name) === key);
}

/** Keep only names that exist in the vocabulary, in vocabulary-canonical form, deduplicated. */
export function canonicalizeThreadTags(
  vocabulary: ReadonlyArray<ProjectThreadTag>,
  names: ReadonlyArray<string>,
): { readonly tags: string[]; readonly unknown: string[] } {
  const tags: string[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const match = findMatchingThreadTag(vocabulary, name);
    if (!match) {
      unknown.push(name);
      continue;
    }
    if (!tags.includes(match.name)) tags.push(match.name);
  }
  return { tags, unknown };
}

/** Count how many live threads carry each tag, for the filter menu and tag manager. */
export function countThreadTags(
  threads: ReadonlyArray<{ readonly tags: ReadonlyArray<string> }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    for (const tag of thread.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
}

/**
 * The sidebar / thread-list filter, shared by web and mobile so both platforms
 * hide exactly the same conversations.
 *
 * - `hideCompleted` drops threads the user marked done.
 * - `selectedTags` keeps only threads carrying at least one of them; empty
 *   means "no tag filter".
 */
export interface ThreadListFilter {
  readonly hideCompleted: boolean;
  readonly selectedTags: ReadonlyArray<string>;
}

export function threadMatchesListFilter(
  thread: { readonly doneAt: string | null; readonly tags: ReadonlyArray<string> },
  filter: ThreadListFilter,
): boolean {
  if (filter.hideCompleted && thread.doneAt !== null) return false;
  if (filter.selectedTags.length > 0) {
    return thread.tags.some((tag) => filter.selectedTags.includes(tag));
  }
  return true;
}

/** One vocabulary for a group of projects that the UI shows as one (same repo, several machines). */
export function mergeThreadTagVocabularies(
  vocabularies: ReadonlyArray<ReadonlyArray<ProjectThreadTag>>,
): ProjectThreadTag[] {
  const byName = new Map<string, ProjectThreadTag>();
  for (const vocabulary of vocabularies) {
    for (const tag of vocabulary) {
      if (!byName.has(tag.name)) byName.set(tag.name, tag);
    }
  }
  return [...byName.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}
