import * as Layer from "effect/Layer";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { ProviderUsageReadingRepositoryLive } from "../persistence/Layers/ProviderUsageReadings.ts";
import { UsageReportQueryLive } from "../provider/Layers/UsageReportQuery.ts";

export const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
);

export const OrchestrationProjectionPipelineLayerLive = OrchestrationProjectionPipelineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
);

/**
 * The plan usage report is a read model over the same projections, so it is
 * built and provided alongside them rather than with the provider runtime —
 * that is what puts it in reach of the socket layer without every caller
 * having to assemble it.
 */
const UsageReportQueryLayerLive = UsageReportQueryLive.pipe(
  Layer.provide(ProviderUsageReadingRepositoryLive),
);

export const OrchestrationInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  UsageReportQueryLayerLive,
  OrchestrationEventInfrastructureLayerLive,
  OrchestrationProjectionPipelineLayerLive,
);

export const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  OrchestrationEngineLive.pipe(Layer.provide(OrchestrationInfrastructureLayerLive)),
);
