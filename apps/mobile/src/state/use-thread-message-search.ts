import {
  searchThreadsAcrossEnvironments,
  type ThreadSearchResponse,
} from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { getEnvironmentClient } from "./environment-session-registry";

const MIN_QUERY_LENGTH = 2;
// Message search costs the server real work per request, so wait for a pause in typing.
const DEBOUNCE_MS = 350;

/**
 * Search the text of every conversation on the connected environments — the
 * same server search the desktop's "search inside conversations" runs.
 */
export function useThreadMessageSearch(input: {
  readonly query: string;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}) {
  const query = input.query.trim();
  const { environmentIds } = input;
  const active = query.length >= MIN_QUERY_LENGTH && environmentIds.length > 0;
  const key = JSON.stringify([query, environmentIds]);
  const [settled, setSettled] = useState<{
    key: string;
    response: ThreadSearchResponse | null;
  } | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timeout = setTimeout(() => {
      void searchThreadsAcrossEnvironments({
        query,
        environmentIds,
        titlesOnly: false,
        resolveClient: getEnvironmentClient,
      }).then(
        (response) => {
          if (!cancelled) setSettled({ key, response });
        },
        () => {
          if (!cancelled) setSettled({ key, response: null });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [active, key, query, environmentIds]);

  const current = active && settled?.key === key ? settled : null;
  return {
    active,
    results: current?.response?.results ?? [],
    pending: active && current === null,
    failed: current !== null && current.response === null,
  };
}
