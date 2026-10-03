import type {
  EnvironmentId,
  OrchestrationSemanticSearchStatus,
  OrchestrationSearchThreadsResult,
  OrchestrationThreadSearchResult,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { readEnvironmentApi } from "../environmentApi";

interface ScopedThreadSearchResult extends OrchestrationThreadSearchResult {
  readonly environmentId: EnvironmentId;
}

interface ThreadSearchResponseState {
  readonly query: string;
  readonly updatedSince: string | null;
  readonly results: ReadonlyArray<ScopedThreadSearchResult>;
  readonly semanticStatus: OrchestrationSemanticSearchStatus;
}

async function searchThreadsAcrossEnvironments(input: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly query: string;
  readonly updatedSince: string | null;
}): Promise<ThreadSearchResponseState | null> {
  const settled = await Promise.allSettled(
    input.environmentIds.map(async (environmentId) => {
      const api = readEnvironmentApi(environmentId);
      if (!api) throw new Error(`Environment ${environmentId} is unavailable.`);
      const response = await api.orchestration.searchThreads({
        query: input.query,
        limit: 30,
        includeArchived: true,
        includeSemantic: true,
        ...(input.updatedSince ? { updatedSince: input.updatedSince } : {}),
      });
      return { environmentId, response };
    }),
  );
  const fulfilled = settled.filter(
    (
      entry,
    ): entry is PromiseFulfilledResult<{
      environmentId: EnvironmentId;
      response: OrchestrationSearchThreadsResult;
    }> => entry.status === "fulfilled",
  );
  if (fulfilled.length === 0) return null;

  const semanticStatus = fulfilled.some((entry) => entry.value.response.semanticStatus === "ready")
    ? "ready"
    : fulfilled.some((entry) => entry.value.response.semanticStatus === "indexing")
      ? "indexing"
      : "unavailable";
  const results = fulfilled
    .flatMap((entry) =>
      entry.value.response.results.map((result) => ({
        ...result,
        environmentId: entry.value.environmentId,
      })),
    )
    // The server hands back one score per relevance tier, so this reads as
    // "loose matches last, everything else newest first" — the same order each
    // environment decided on its own, preserved across the merge.
    .toSorted(
      (left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, 30);
  return { query: input.query, updatedSince: input.updatedSince, results, semanticStatus };
}

interface SearchInput {
  readonly query: string;
  readonly updatedSince: string | null;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly enabled: boolean;
}

/** Publish one complete result set. Never replace clickable local/keyword hits with later ranking. */
export function useConversationSearch(input: SearchInput) {
  const { updatedSince, environmentIds, enabled } = input;
  const query = input.query.trim();
  const active = enabled && query.length >= 2 && environmentIds.length > 0;
  const key = JSON.stringify([query, updatedSince, environmentIds]);
  const [settled, setSettled] = useState<{
    key: string;
    response: ThreadSearchResponseState | null;
  } | null>(null);

  useEffect(() => {
    setSettled(null);
    if (!active) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void searchThreadsAcrossEnvironments({ query, updatedSince, environmentIds }).then(
        (response) => {
          if (!cancelled) setSettled({ key, response });
        },
        () => {
          if (!cancelled) setSettled({ key, response: null });
        },
      );
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [active, key, query, updatedSince, environmentIds]);

  const current = active && settled?.key === key ? settled : null;
  return {
    response: current?.response ?? null,
    pending: active && current === null,
    failed: current !== null && current.response === null,
  };
}
