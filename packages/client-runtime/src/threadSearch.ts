import type {
  EnvironmentId,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationSemanticSearchStatus,
  OrchestrationThreadSearchResult,
} from "@t3tools/contracts";

export interface ScopedThreadSearchResult extends OrchestrationThreadSearchResult {
  readonly environmentId: EnvironmentId;
}

export interface ThreadSearchResponse {
  readonly results: ReadonlyArray<ScopedThreadSearchResult>;
  readonly semanticStatus: OrchestrationSemanticSearchStatus;
}

/** The one capability thread search needs from an environment connection. */
export interface ThreadSearchClient {
  readonly orchestration: {
    readonly searchThreads: (
      input: OrchestrationSearchThreadsInput,
    ) => Promise<OrchestrationSearchThreadsResult>;
  };
}

export const THREAD_SEARCH_RESULT_LIMIT = 30;

/**
 * Search every connected environment's threads and merge the answers into one
 * ranked list. An environment that is offline or fails is skipped rather than
 * failing the whole search; null means every environment failed.
 */
export async function searchThreadsAcrossEnvironments(input: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly resolveClient: (environmentId: EnvironmentId) => ThreadSearchClient | null | undefined;
  readonly query: string;
  readonly updatedSince?: string | null;
  /** Titles, project names and branches only; message text is opt-in. */
  readonly titlesOnly: boolean;
  readonly includeSemantic?: boolean;
}): Promise<ThreadSearchResponse | null> {
  const settled = await Promise.allSettled(
    input.environmentIds.map(async (environmentId) => {
      const client = input.resolveClient(environmentId);
      if (!client) throw new Error(`Environment ${environmentId} is unavailable.`);
      const response = await client.orchestration.searchThreads({
        query: input.query,
        limit: THREAD_SEARCH_RESULT_LIMIT,
        includeArchived: true,
        includeSemantic: input.includeSemantic ?? !input.titlesOnly,
        titlesOnly: input.titlesOnly,
        ...(input.updatedSince ? { updatedSince: input.updatedSince } : {}),
      });
      return { environmentId, response };
    }),
  );
  const fulfilled = settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
  if (fulfilled.length === 0) return null;

  const semanticStatus: OrchestrationSemanticSearchStatus = fulfilled.some(
    (entry) => entry.response.semanticStatus === "ready",
  )
    ? "ready"
    : fulfilled.some((entry) => entry.response.semanticStatus === "indexing")
      ? "indexing"
      : "unavailable";
  const results = fulfilled
    .flatMap((entry) =>
      entry.response.results.map((result) => ({
        ...result,
        environmentId: entry.environmentId,
      })),
    )
    // The server hands back one score per relevance tier, so this reads as
    // "loose matches last, everything else newest first" — the same order each
    // environment decided on its own, preserved across the merge.
    .toSorted(
      (left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, THREAD_SEARCH_RESULT_LIMIT);
  return { results, semanticStatus };
}
