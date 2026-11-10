import {
  searchThreadsAcrossEnvironments,
  type ThreadSearchResponse,
} from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { readEnvironmentApi } from "../environmentApi";

/** A result set plus the request it answers, so a stale answer can be told apart. */
interface ThreadSearchResponseState extends ThreadSearchResponse {
  readonly query: string;
  readonly updatedSince: string | null;
  readonly titlesOnly: boolean;
}

interface SearchInput {
  readonly query: string;
  readonly updatedSince: string | null;
  /** Titles, project names and branches only; message text is opt-in. */
  readonly titlesOnly: boolean;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly enabled: boolean;
}

/** Publish one complete result set. Never replace clickable local/keyword hits with later ranking. */
export function useConversationSearch(input: SearchInput) {
  const { updatedSince, titlesOnly, environmentIds, enabled } = input;
  const query = input.query.trim();
  const active = enabled && query.length >= 2 && environmentIds.length > 0;
  const key = JSON.stringify([query, updatedSince, titlesOnly, environmentIds]);
  const [settled, setSettled] = useState<{
    key: string;
    response: ThreadSearchResponseState | null;
  } | null>(null);

  useEffect(() => {
    setSettled(null);
    if (!active) return;
    let cancelled = false;
    // Message search costs the server real work per request, so it waits for a
    // longer pause in typing than the near-free title search does.
    const timeout = window.setTimeout(
      () => {
        void searchThreadsAcrossEnvironments({
          query,
          updatedSince,
          titlesOnly,
          environmentIds,
          resolveClient: readEnvironmentApi,
        }).then(
          (response) => {
            if (!cancelled)
              setSettled({
                key,
                response: response && { ...response, query, updatedSince, titlesOnly },
              });
          },
          () => {
            if (!cancelled) setSettled({ key, response: null });
          },
        );
      },
      titlesOnly ? 150 : 350,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [active, key, query, updatedSince, titlesOnly, environmentIds]);

  const current = active && settled?.key === key ? settled : null;
  return {
    response: current?.response ?? null,
    pending: active && current === null,
    failed: current !== null && current.response === null,
  };
}
