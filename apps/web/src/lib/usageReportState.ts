import { useAtomValue } from "@effect/atom-react";
import type { ServerUsageReportResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { ensureLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";

/**
 * The report reads a whole reset period at a time, and the underlying tape only
 * gains a row when a provider volunteers one — so refetching aggressively buys
 * nothing. Half a minute keeps a settings tab that stays open roughly current
 * without re-running the scan on every render.
 */
const USAGE_REPORT_STALE_TIME_MS = 30_000;
const USAGE_REPORT_IDLE_TTL_MS = 5 * 60_000;

const usageReportAtom = Atom.family((windowId: string) =>
  Atom.make(
    Effect.promise(() =>
      ensureLocalApi().server.getUsageReport(windowId === "" ? {} : { windowId }),
    ),
  ).pipe(
    Atom.swr({ staleTime: USAGE_REPORT_STALE_TIME_MS, revalidateOnMount: true }),
    Atom.setIdleTTL(USAGE_REPORT_IDLE_TTL_MS),
    Atom.withLabel(`usage-report:${windowId === "" ? "default" : windowId}`),
  ),
);

export interface UsageReportState {
  readonly data: ServerUsageReportResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

function readUsageReportError(
  result: AsyncResult.AsyncResult<ServerUsageReportResult, unknown>,
): string | null {
  if (result._tag !== "Failure") return null;
  const squashed = Cause.squash(result.cause);
  return squashed instanceof Error ? squashed.message : "Failed to load the usage report.";
}

/** Pass an empty window id to let the server pick the longest window it has. */
export function useUsageReport(windowId: string): UsageReportState {
  const atom = usageReportAtom(windowId);
  const result = useAtomValue(atom);
  const refresh = useCallback(() => {
    appAtomRegistry.refresh(atom);
  }, [atom]);

  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: readUsageReportError(result),
    isPending: result.waiting,
    refresh,
  };
}
