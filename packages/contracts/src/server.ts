import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { ServerAuthDescriptor } from "./auth.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  KeybindingCommand,
  KeybindingValue,
  KeybindingWhen,
  ResolvedKeybindingsConfig,
} from "./keybindings.ts";
import { EditorId } from "./editor.ts";
import { ModelCapabilities } from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ServerSettings } from "./settings.ts";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = Schema.Array(ServerConfigIssue);

export const ServerProviderState = Schema.Literals(["ready", "warning", "error", "disabled"]);
export type ServerProviderState = typeof ServerProviderState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderAuth = Schema.Struct({
  status: ServerProviderAuthStatus,
  type: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderAuth = typeof ServerProviderAuth.Type;

export const ServerProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
  isCustom: Schema.Boolean,
  capabilities: Schema.NullOr(ModelCapabilities),
});
export type ServerProviderModel = typeof ServerProviderModel.Type;

export const ServerProviderSlashCommandInput = Schema.Struct({
  hint: TrimmedNonEmptyString,
});
export type ServerProviderSlashCommandInput = typeof ServerProviderSlashCommandInput.Type;

export const ServerProviderSlashCommand = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  input: Schema.optional(ServerProviderSlashCommandInput),
});
export type ServerProviderSlashCommand = typeof ServerProviderSlashCommand.Type;

export const ServerProviderSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  path: TrimmedNonEmptyString,
  scope: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  displayName: Schema.optional(TrimmedNonEmptyString),
  shortDescription: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderSkill = typeof ServerProviderSkill.Type;

/**
 * Availability of a configured provider instance from the runtime's POV.
 *
 *  - `available` — the build ships this driver and an instance is wired
 *    up. Default for legacy snapshots produced from the closed
 *    `ServerSettings.providers` map.
 *  - `unavailable` — the user's `ServerSettings.providerInstances` (or a
 *    persisted thread / session binding) references a driver this build
 *    doesn't ship. Common after rolling back from a fork or PR branch
 *    that introduced a new driver. The snapshot is preserved so the UI
 *    can render "missing driver" affordances and so the data round-trips
 *    when the user moves back to the fork.
 *
 * Snapshots with `availability: "unavailable"` MUST set
 * `installed: false` and `enabled: false`; the runtime refuses turn
 * starts against them with a structured error.
 */
export const ServerProviderAvailability = Schema.Literals(["available", "unavailable"]);
export type ServerProviderAvailability = typeof ServerProviderAvailability.Type;

export const ServerProviderContinuation = Schema.Struct({
  groupKey: TrimmedNonEmptyString,
});
export type ServerProviderContinuation = typeof ServerProviderContinuation.Type;

export const ServerProviderVersionAdvisoryStatus = Schema.Literals([
  "unknown",
  "current",
  "behind_latest",
]);
export type ServerProviderVersionAdvisoryStatus = typeof ServerProviderVersionAdvisoryStatus.Type;

export const ServerProviderVersionAdvisory = Schema.Struct({
  status: ServerProviderVersionAdvisoryStatus,
  currentVersion: Schema.NullOr(TrimmedNonEmptyString),
  latestVersion: Schema.NullOr(TrimmedNonEmptyString),
  updateCommand: Schema.NullOr(TrimmedNonEmptyString),
  canUpdate: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  checkedAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerProviderVersionAdvisory = typeof ServerProviderVersionAdvisory.Type;

export const ServerProviderUpdateStatus = Schema.Literals([
  "idle",
  "queued",
  "running",
  "succeeded",
  "failed",
  "unchanged",
]);
export type ServerProviderUpdateStatus = typeof ServerProviderUpdateStatus.Type;

export const ServerProviderUpdateState = Schema.Struct({
  status: ServerProviderUpdateStatus,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(TrimmedNonEmptyString),
  output: Schema.NullOr(Schema.String.check(Schema.isMaxLength(10_000))),
});
export type ServerProviderUpdateState = typeof ServerProviderUpdateState.Type;

/**
 * Percentage of a rate-limit window consumed, `0`–`100`.
 *
 * Providers report this as an integer today, but the schema accepts any
 * number in range: Claude's `utilization` and Codex's `usedPercent` are
 * independent APIs and neither documents integrality as a guarantee.
 * Normalizers clamp out-of-range values rather than dropping the window.
 */
export const ServerProviderUsagePercent = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 100 }),
);
export type ServerProviderUsagePercent = typeof ServerProviderUsagePercent.Type;

export const ServerProviderUsageSeverity = Schema.Literals(["normal", "warning", "critical"]);
export type ServerProviderUsageSeverity = typeof ServerProviderUsageSeverity.Type;

/**
 * One plan rate-limit window (e.g. Claude's rolling 5-hour window, Codex's
 * `primary` window).
 *
 * `id` is the merge key for sparse provider updates: both Claude's
 * `rate_limit_event` and Codex's `account/rateLimits/updated` push a *subset*
 * of windows, and consumers merge by `id` rather than replacing the array.
 * It is provider-scoped — `"five_hour"` from Claude and `"primary"` from
 * Codex never collide because a snapshot only ever carries one provider's
 * windows.
 */
export const ServerProviderUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  // `null` distinguishes "this window exists but the provider did not report
  // utilization" from "this window does not exist" (absent from `windows`).
  percent: Schema.NullOr(ServerProviderUsagePercent),
  resetsAt: Schema.NullOr(IsoDateTime),
  severity: Schema.optionalKey(ServerProviderUsageSeverity),
  // How wide the window is, in minutes (300 for a 5-hour session, 10080 for a
  // week). Optional: a provider may report a window without saying how long it
  // spans. Paired with `resetsAt` it gives the window's *start*, which is the
  // only way the UI can compare burn rate against elapsed time and tell the
  // user whether they are on pace to exhaust the window before it resets.
  windowMinutes: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThan(0))),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

/**
 * Subscription plan usage for a provider instance.
 *
 * Only populated for providers that expose plan rate limits (Claude via the
 * Agent SDK usage API, Codex via `account/rateLimits/read`). `available:
 * false` means plan limits do not apply to this session at all — API-key,
 * Bedrock, and Vertex sessions bill per token and have no plan window — and
 * is distinct from an absent `usage`, which means "not yet observed".
 */
export const ServerProviderUsage = Schema.Struct({
  available: Schema.Boolean,
  planLabel: Schema.NullOr(TrimmedNonEmptyString),
  windows: Schema.Array(ServerProviderUsageWindow).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  // Staleness marker. Usage is never hydrated from the on-disk provider
  // status cache, so this is always from the current process.
  capturedAt: IsoDateTime,
  source: Schema.Literals(["event", "probe"]),
  // Why usage is unavailable, when `available` is false.
  message: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ServerProviderUsage = typeof ServerProviderUsage.Type;

export const ServerProvider = Schema.Struct({
  // Routing key for the configured instance this snapshot represents. This
  // is the only stable identity consumers may use for provider routing.
  instanceId: ProviderInstanceId,
  // Open driver kind slug that selects the implementation handling this
  // instance. It is metadata/capability context, not a routing key.
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  badgeLabel: Schema.optional(TrimmedNonEmptyString),
  continuation: Schema.optional(ServerProviderContinuation),
  showInteractionModeToggle: Schema.optional(Schema.Boolean),
  requiresNewThreadForModelChange: Schema.optional(Schema.Boolean),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  status: ServerProviderState,
  auth: ServerProviderAuth,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  // Optional for back-compat: every legacy producer omits this field and
  // an absent value is interpreted as `"available"` by consumers (see
  // `isProviderAvailable`). New `ProviderInstanceRegistry` outputs set it
  // explicitly so the UI can render unavailable shadows from
  // `ServerSettings.providerInstances`.
  availability: Schema.optional(ServerProviderAvailability),
  // Human-readable reason populated when `availability === "unavailable"`.
  // Surfaces in the UI alongside the missing-driver affordance.
  unavailableReason: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(ServerProviderModel),
  slashCommands: Schema.Array(ServerProviderSlashCommand).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  skills: Schema.Array(ServerProviderSkill).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  versionAdvisory: Schema.optionalKey(ServerProviderVersionAdvisory),
  updateState: Schema.optionalKey(ServerProviderUpdateState),
  // `optionalKey` for back-compat: cached snapshots written before this
  // field existed must still decode. Absent means "no plan-usage data
  // observed yet", which is also the steady state for providers that never
  // report it (cursor, grok, opencode).
  usage: Schema.optionalKey(ServerProviderUsage),
});
export type ServerProvider = typeof ServerProvider.Type;

export const ServerProviders = Schema.Array(ServerProvider);
export type ServerProviders = typeof ServerProviders.Type;

/**
 * Treat the optional `availability` as "available" when absent. This is
 * the rule legacy producers (which omit the field) and new producers
 * (which set it explicitly) agree on so consumers never have to thread
 * `?? "available"` defaults through their code paths.
 */
export const isProviderAvailable = (snapshot: ServerProvider): boolean =>
  snapshot.availability !== "unavailable";

export const ServerObservability = Schema.Struct({
  logsDirectoryPath: TrimmedNonEmptyString,
  localTracingEnabled: Schema.Boolean,
  otlpTracesUrl: Schema.optional(TrimmedNonEmptyString),
  otlpTracesEnabled: Schema.Boolean,
  otlpMetricsUrl: Schema.optional(TrimmedNonEmptyString),
  otlpMetricsEnabled: Schema.Boolean,
});
export type ServerObservability = typeof ServerObservability.Type;

export const ServerTraceDiagnosticsErrorKind = Schema.Literals([
  "trace-file-not-found",
  "trace-file-read-failed",
]);
export type ServerTraceDiagnosticsErrorKind = typeof ServerTraceDiagnosticsErrorKind.Type;

export const ServerTraceDiagnosticsSpanSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  count: NonNegativeInt,
  failureCount: NonNegativeInt,
  totalDurationMs: Schema.Number,
  averageDurationMs: Schema.Number,
  maxDurationMs: Schema.Number,
});
export type ServerTraceDiagnosticsSpanSummary = typeof ServerTraceDiagnosticsSpanSummary.Type;

export const ServerTraceDiagnosticsFailureSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  cause: TrimmedNonEmptyString,
  count: NonNegativeInt,
  lastSeenAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsFailureSummary = typeof ServerTraceDiagnosticsFailureSummary.Type;

export const ServerTraceDiagnosticsRecentFailure = Schema.Struct({
  name: TrimmedNonEmptyString,
  cause: TrimmedNonEmptyString,
  durationMs: Schema.Number,
  endedAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsRecentFailure = typeof ServerTraceDiagnosticsRecentFailure.Type;

export const ServerTraceDiagnosticsSpanOccurrence = Schema.Struct({
  name: TrimmedNonEmptyString,
  durationMs: Schema.Number,
  endedAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsSpanOccurrence = typeof ServerTraceDiagnosticsSpanOccurrence.Type;

export const ServerTraceDiagnosticsLogEvent = Schema.Struct({
  spanName: TrimmedNonEmptyString,
  level: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  seenAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsLogEvent = typeof ServerTraceDiagnosticsLogEvent.Type;

export const ServerTraceDiagnosticsResult = Schema.Struct({
  traceFilePath: TrimmedNonEmptyString,
  scannedFilePaths: Schema.Array(TrimmedNonEmptyString),
  readAt: Schema.DateTimeUtc,
  recordCount: NonNegativeInt,
  parseErrorCount: NonNegativeInt,
  firstSpanAt: Schema.Option(Schema.DateTimeUtc),
  lastSpanAt: Schema.Option(Schema.DateTimeUtc),
  failureCount: NonNegativeInt,
  interruptionCount: NonNegativeInt,
  slowSpanThresholdMs: NonNegativeInt,
  slowSpanCount: NonNegativeInt,
  logLevelCounts: Schema.Record(TrimmedNonEmptyString, NonNegativeInt),
  topSpansByCount: Schema.Array(ServerTraceDiagnosticsSpanSummary),
  slowestSpans: Schema.Array(ServerTraceDiagnosticsSpanOccurrence),
  commonFailures: Schema.Array(ServerTraceDiagnosticsFailureSummary),
  latestFailures: Schema.Array(ServerTraceDiagnosticsRecentFailure),
  latestWarningAndErrorLogs: Schema.Array(ServerTraceDiagnosticsLogEvent),
  partialFailure: Schema.Option(Schema.Boolean),
  error: Schema.Option(
    Schema.Struct({
      kind: ServerTraceDiagnosticsErrorKind,
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type ServerTraceDiagnosticsResult = typeof ServerTraceDiagnosticsResult.Type;

export const ServerProcessSignal = Schema.Literals(["SIGINT", "SIGKILL"]);
export type ServerProcessSignal = typeof ServerProcessSignal.Type;

export const ServerProcessDiagnosticsEntry = Schema.Struct({
  pid: PositiveInt,
  ppid: NonNegativeInt,
  pgid: Schema.Option(Schema.Int),
  status: TrimmedNonEmptyString,
  cpuPercent: Schema.Number,
  rssBytes: NonNegativeInt,
  elapsed: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  depth: NonNegativeInt,
  childPids: Schema.Array(PositiveInt),
});
export type ServerProcessDiagnosticsEntry = typeof ServerProcessDiagnosticsEntry.Type;

export const ServerProcessDiagnosticsResult = Schema.Struct({
  serverPid: PositiveInt,
  readAt: Schema.DateTimeUtc,
  processCount: NonNegativeInt,
  totalRssBytes: NonNegativeInt,
  totalCpuPercent: Schema.Number,
  processes: Schema.Array(ServerProcessDiagnosticsEntry),
  error: Schema.Option(
    Schema.Struct({
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type ServerProcessDiagnosticsResult = typeof ServerProcessDiagnosticsResult.Type;

export const ServerProcessResourceHistoryInput = Schema.Struct({
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
});
export type ServerProcessResourceHistoryInput = typeof ServerProcessResourceHistoryInput.Type;

export const ServerProcessResourceHistoryBucket = Schema.Struct({
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.DateTimeUtc,
  avgCpuPercent: Schema.Number,
  maxCpuPercent: Schema.Number,
  maxRssBytes: NonNegativeInt,
  maxProcessCount: NonNegativeInt,
});
export type ServerProcessResourceHistoryBucket = typeof ServerProcessResourceHistoryBucket.Type;

export const ServerProcessResourceHistorySummary = Schema.Struct({
  processKey: TrimmedNonEmptyString,
  pid: PositiveInt,
  ppid: NonNegativeInt,
  command: TrimmedNonEmptyString,
  depth: NonNegativeInt,
  isServerRoot: Schema.Boolean,
  firstSeenAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.DateTimeUtc,
  currentCpuPercent: Schema.Number,
  avgCpuPercent: Schema.Number,
  maxCpuPercent: Schema.Number,
  cpuSecondsApprox: Schema.Number,
  currentRssBytes: NonNegativeInt,
  maxRssBytes: NonNegativeInt,
  sampleCount: NonNegativeInt,
});
export type ServerProcessResourceHistorySummary = typeof ServerProcessResourceHistorySummary.Type;

export const ServerProcessResourceHistoryResult = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
  sampleIntervalMs: NonNegativeInt,
  retainedSampleCount: NonNegativeInt,
  totalCpuSecondsApprox: Schema.Number,
  buckets: Schema.Array(ServerProcessResourceHistoryBucket),
  topProcesses: Schema.Array(ServerProcessResourceHistorySummary),
  error: Schema.Option(
    Schema.Struct({
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type ServerProcessResourceHistoryResult = typeof ServerProcessResourceHistoryResult.Type;

export const ServerSignalProcessInput = Schema.Struct({
  pid: PositiveInt,
  signal: ServerProcessSignal,
});
export type ServerSignalProcessInput = typeof ServerSignalProcessInput.Type;

export const ServerSignalProcessResult = Schema.Struct({
  pid: PositiveInt,
  signal: ServerProcessSignal,
  signaled: Schema.Boolean,
  message: Schema.Option(TrimmedNonEmptyString),
});
export type ServerSignalProcessResult = typeof ServerSignalProcessResult.Type;

export const ServerConfig = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  auth: ServerAuthDescriptor,
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  // Workspace root for the auto-created orchestrator project. Lives in the
  // server's own state directory, never in the user's code, because the
  // orchestrator is not supposed to touch a repository. Sent to the client so
  // it can create the project on first use without guessing server paths.
  orchestratorWorkspaceRoot: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviders,
  availableEditors: Schema.Array(EditorId),
  observability: ServerObservability,
  settings: ServerSettings,
});
export type ServerConfig = typeof ServerConfig.Type;

const ServerUpsertKeybindingReplaceTarget = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
});

export const ServerUpsertKeybindingInput = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
  replace: Schema.optional(ServerUpsertKeybindingReplaceTarget),
});
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerRemoveKeybindingInput = ServerUpsertKeybindingReplaceTarget;
export type ServerRemoveKeybindingInput = typeof ServerRemoveKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerRemoveKeybindingResult = ServerUpsertKeybindingResult;
export type ServerRemoveKeybindingResult = typeof ServerRemoveKeybindingResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviders,
  settings: Schema.optional(ServerSettings),
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

export const ServerConfigKeybindingsUpdatedPayload = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerConfigKeybindingsUpdatedPayload =
  typeof ServerConfigKeybindingsUpdatedPayload.Type;

export const ServerConfigProviderStatusesPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerConfigProviderStatusesPayload = typeof ServerConfigProviderStatusesPayload.Type;

export const ServerConfigSettingsUpdatedPayload = Schema.Struct({
  settings: ServerSettings,
});
export type ServerConfigSettingsUpdatedPayload = typeof ServerConfigSettingsUpdatedPayload.Type;

export const ServerConfigStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("snapshot"),
  config: ServerConfig,
});
export type ServerConfigStreamSnapshotEvent = typeof ServerConfigStreamSnapshotEvent.Type;

export const ServerConfigStreamKeybindingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("keybindingsUpdated"),
  payload: ServerConfigKeybindingsUpdatedPayload,
});
export type ServerConfigStreamKeybindingsUpdatedEvent =
  typeof ServerConfigStreamKeybindingsUpdatedEvent.Type;

export const ServerConfigStreamProviderStatusesEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("providerStatuses"),
  payload: ServerConfigProviderStatusesPayload,
});
export type ServerConfigStreamProviderStatusesEvent =
  typeof ServerConfigStreamProviderStatusesEvent.Type;

export const ServerConfigStreamSettingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("settingsUpdated"),
  payload: ServerConfigSettingsUpdatedPayload,
});
export type ServerConfigStreamSettingsUpdatedEvent =
  typeof ServerConfigStreamSettingsUpdatedEvent.Type;

export const ServerConfigStreamEvent = Schema.Union([
  ServerConfigStreamSnapshotEvent,
  ServerConfigStreamKeybindingsUpdatedEvent,
  ServerConfigStreamProviderStatusesEvent,
  ServerConfigStreamSettingsUpdatedEvent,
]);
export type ServerConfigStreamEvent = typeof ServerConfigStreamEvent.Type;

export const ServerLifecycleReadyPayload = Schema.Struct({
  at: IsoDateTime,
  environment: ExecutionEnvironmentDescriptor,
});
export type ServerLifecycleReadyPayload = typeof ServerLifecycleReadyPayload.Type;

export const ServerLifecycleWelcomePayload = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  cwd: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
});
export type ServerLifecycleWelcomePayload = typeof ServerLifecycleWelcomePayload.Type;

export const ServerLifecycleStreamWelcomeEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("welcome"),
  payload: ServerLifecycleWelcomePayload,
});
export type ServerLifecycleStreamWelcomeEvent = typeof ServerLifecycleStreamWelcomeEvent.Type;

export const ServerLifecycleStreamReadyEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("ready"),
  payload: ServerLifecycleReadyPayload,
});
export type ServerLifecycleStreamReadyEvent = typeof ServerLifecycleStreamReadyEvent.Type;

export const ServerLifecycleStreamEvent = Schema.Union([
  ServerLifecycleStreamWelcomeEvent,
  ServerLifecycleStreamReadyEvent,
]);
export type ServerLifecycleStreamEvent = typeof ServerLifecycleStreamEvent.Type;

export const ServerProviderUpdatedPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerProviderUpdatedPayload = typeof ServerProviderUpdatedPayload.Type;

export const ServerProviderUpdateInput = Schema.Struct({
  provider: ProviderDriverKind,
  instanceId: Schema.optionalKey(ProviderInstanceId),
});
export type ServerProviderUpdateInput = typeof ServerProviderUpdateInput.Type;

export class ServerProviderUpdateError extends Schema.TaggedErrorClass<ServerProviderUpdateError>()(
  "ServerProviderUpdateError",
  {
    provider: ProviderDriverKind,
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider update failed for ${this.provider}: ${this.reason}`;
  }
}

/**
 * Input for the plan usage report.
 *
 * Every field is optional because the useful default — every account, the
 * longest window each one has, all recorded periods — is also the one an
 * invoice is written from.
 */
export const ServerUsageReportInput = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
  windowId: Schema.optional(TrimmedNonEmptyString),
  /** How many reset periods to return per account, newest first. */
  periodLimit: Schema.optional(PositiveInt),
});
export type ServerUsageReportInput = typeof ServerUsageReportInput.Type;

/**
 * Allowance consumed by one project on one model, in points of the window.
 *
 * "Points" and not "percent of what you used": 12 here means twelve percent of
 * the whole weekly allowance, so the numbers across a period add up to the
 * period's observed consumption rather than to 100.
 */
export const ServerUsageReportAllocation = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  projectTitle: Schema.NullOr(TrimmedNonEmptyString),
  model: Schema.NullOr(TrimmedNonEmptyString),
  percent: Schema.Number,
  tokens: Schema.Number,
});
export type ServerUsageReportAllocation = typeof ServerUsageReportAllocation.Type;

/** One billing period of a window — everything between two of its resets. */
export const ServerUsageReportPeriod = Schema.Struct({
  resetsAt: Schema.NullOr(IsoDateTime),
  firstReadingAt: IsoDateTime,
  lastReadingAt: IsoDateTime,
  /** Already consumed when recording started, so never attributable. */
  openingPercent: Schema.Number,
  closingPercent: Schema.Number,
  observedPercent: Schema.Number,
  attributedPercent: Schema.Number,
  /** Consumed while nothing was running here — another tool, or another person. */
  elsewherePercent: Schema.Number,
  allocations: Schema.Array(ServerUsageReportAllocation),
});
export type ServerUsageReportPeriod = typeof ServerUsageReportPeriod.Type;

/** One provider account's report, for the single window it was asked about. */
export const ServerUsageReportAccount = Schema.Struct({
  instanceId: ProviderInstanceId,
  planLabel: Schema.NullOr(TrimmedNonEmptyString),
  windowId: TrimmedNonEmptyString,
  windowLabel: TrimmedNonEmptyString,
  windowMinutes: Schema.NullOr(Schema.Number),
  availableWindowIds: Schema.Array(TrimmedNonEmptyString),
  periods: Schema.Array(ServerUsageReportPeriod),
});
export type ServerUsageReportAccount = typeof ServerUsageReportAccount.Type;

export const ServerUsageReportResult = Schema.Struct({
  readAt: IsoDateTime,
  /** Oldest reading held, so the UI can say how far back the answer is good for. */
  recordingSince: Schema.NullOr(IsoDateTime),
  accounts: Schema.Array(ServerUsageReportAccount),
});
export type ServerUsageReportResult = typeof ServerUsageReportResult.Type;

export class ServerUsageReportError extends Schema.TaggedErrorClass<ServerUsageReportError>()(
  "ServerUsageReportError",
  {
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to build the plan usage report: ${this.reason}`;
  }
}
