/**
 * UsageReportQuery — read model behind the plan usage report.
 *
 * Assembles three things the store already holds separately: the tape of
 * rate-limit readings (`provider_usage_readings`), the token counts recorded
 * against each response, and which account and model each turn ran on. The
 * arithmetic that joins them lives in `usageAttribution.ts`; this service is
 * only the loader and the shape of the answer.
 *
 * @module provider/Services/UsageReportQuery
 */
import type { ServerUsageReportInput, ServerUsageReportResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface UsageReportQueryShape {
  readonly getUsageReport: (
    input: ServerUsageReportInput,
  ) => Effect.Effect<ServerUsageReportResult, ProjectionRepositoryError>;
}

export class UsageReportQuery extends Context.Service<UsageReportQuery, UsageReportQueryShape>()(
  "t3/provider/Services/UsageReportQuery",
) {}
