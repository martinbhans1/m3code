import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { ProjectId, ThreadId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { DatabaseConnectionConfig, DatabaseConnectionId } from "./database.ts";
import { ProjectToolServerConfig, ProjectToolServerId } from "./projectToolServers.ts";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL, ProviderOptionSelections } from "./model.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProviderInstanceConfig, ProviderInstanceId } from "./providerInstance.ts";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const ProviderUsageAlertThreshold = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 100 }),
);
export type ProviderUsageAlertThreshold = typeof ProviderUsageAlertThreshold.Type;
export const DEFAULT_PROVIDER_USAGE_ALERT_THRESHOLDS = [
  50, 80,
] as const satisfies ReadonlyArray<ProviderUsageAlertThreshold>;

// How long an alert stays silent for a window that is still above a threshold
// it already reported. `0` means "report a crossing once and never repeat it"
// — the alert only re-arms after usage falls back below the threshold.
export const MIN_PROVIDER_USAGE_ALERT_REPEAT_MINUTES = 0;
export const MAX_PROVIDER_USAGE_ALERT_REPEAT_MINUTES = 1440;
export const ProviderUsageAlertRepeatMinutes = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_PROVIDER_USAGE_ALERT_REPEAT_MINUTES,
    maximum: MAX_PROVIDER_USAGE_ALERT_REPEAT_MINUTES,
  }),
);
export type ProviderUsageAlertRepeatMinutes = typeof ProviderUsageAlertRepeatMinutes.Type;
export const DEFAULT_PROVIDER_USAGE_ALERT_REPEAT_MINUTES: ProviderUsageAlertRepeatMinutes = 0;

// Seconds before a usage toast dismisses itself. `0` keeps it on screen until
// it is dismissed by hand.
export const MIN_PROVIDER_USAGE_ALERT_AUTO_DISMISS_SECONDS = 0;
export const MAX_PROVIDER_USAGE_ALERT_AUTO_DISMISS_SECONDS = 600;
export const ProviderUsageAlertAutoDismissSeconds = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_PROVIDER_USAGE_ALERT_AUTO_DISMISS_SECONDS,
    maximum: MAX_PROVIDER_USAGE_ALERT_AUTO_DISMISS_SECONDS,
  }),
);
export type ProviderUsageAlertAutoDismissSeconds = typeof ProviderUsageAlertAutoDismissSeconds.Type;
export const DEFAULT_PROVIDER_USAGE_ALERT_AUTO_DISMISS_SECONDS: ProviderUsageAlertAutoDismissSeconds = 10;

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;
export const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";
export const MIN_SIDEBAR_THREAD_PREVIEW_COUNT = 1;
export const MAX_SIDEBAR_THREAD_PREVIEW_COUNT = 15;
export const SidebarThreadPreviewCount = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
    maximum: MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  }),
);
export type SidebarThreadPreviewCount = typeof SidebarThreadPreviewCount.Type;
export const DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT: SidebarThreadPreviewCount = 6;

// How many additional threads each "Show more" click reveals within a project
// group. The reveal is incremental: the list grows by this many rows per click
// until every thread is shown, at which point "Show less" collapses back to the
// preview count above.
export const MIN_SIDEBAR_THREAD_SHOW_MORE_INCREMENT = 1;
export const MAX_SIDEBAR_THREAD_SHOW_MORE_INCREMENT = 50;
export const SidebarThreadShowMoreIncrement = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_THREAD_SHOW_MORE_INCREMENT,
    maximum: MAX_SIDEBAR_THREAD_SHOW_MORE_INCREMENT,
  }),
);
export type SidebarThreadShowMoreIncrement = typeof SidebarThreadShowMoreIncrement.Type;
export const DEFAULT_SIDEBAR_THREAD_SHOW_MORE_INCREMENT: SidebarThreadShowMoreIncrement = 5;

// System notifications are the OS-level toasts (Windows Action Center, macOS
// Notification Center), as opposed to the in-app toasts. They exist for the
// case the app cannot cover on its own: an agent that finished, failed, or is
// blocked on an answer while its window is behind everything else. Defaulted
// on, because a thread nobody notices is the exact failure this prevents —
// each category can be switched off individually if it turns out to be noise.
export const DEFAULT_SYSTEM_NOTIFICATIONS_ENABLED = true;
export const DEFAULT_SYSTEM_NOTIFY_ON_TURN_COMPLETED = true;
export const DEFAULT_SYSTEM_NOTIFY_ON_INPUT_NEEDED = true;
export const DEFAULT_SYSTEM_NOTIFY_ON_FAILURE = true;
// Off by default: a thread finishing in a project you are not looking at is
// still worth a toast even while the app has focus. The one thread that never
// notifies is the one already open in front of you, which is not a setting.
export const DEFAULT_SYSTEM_NOTIFICATIONS_SUPPRESS_WHEN_FOCUSED = false;

export const ClientSettingsSchema = Schema.Struct({
  autoOpenPlanSidebar: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  dismissedProviderUpdateNotificationKeys: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  providerUsageAlertThresholds: Schema.Array(ProviderUsageAlertThreshold).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_USAGE_ALERT_THRESHOLDS)),
  ),
  providerUsageAlertRepeatMinutes: ProviderUsageAlertRepeatMinutes.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_USAGE_ALERT_REPEAT_MINUTES)),
  ),
  providerUsageAlertAutoDismissSeconds: ProviderUsageAlertAutoDismissSeconds.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_USAGE_ALERT_AUTO_DISMISS_SECONDS)),
  ),
  diffIgnoreWhitespace: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  diffWordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Model favorites. Historically keyed by provider kind, now
  // widened to `ProviderInstanceId` so users can favorite a specific model
  // on a custom provider instance (e.g. "Codex Personal · gpt-5") without
  // the UI collapsing it into the same bucket as the default Codex. The
  // widening is backward-compatible by construction: prior provider-kind
  // strings satisfy the `ProviderInstanceId` slug schema, so previously
  // persisted favorites decode unchanged and continue to point at the
  // default instance for their kind (because `defaultInstanceIdForDriver(kind)`
  // uses the same slug). The field name is kept as `provider` for storage
  // stability; new call sites should treat the value as an instance id.
  favorites: Schema.Array(
    Schema.Struct({
      provider: ProviderInstanceId,
      model: TrimmedNonEmptyString,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerModelPreferences: Schema.Record(
    ProviderInstanceId,
    Schema.Struct({
      hiddenModels: Schema.Array(Schema.String).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
      ),
      modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // Whether to show the per-thread pull-request / change-request status icon in
  // the sidebar. Defaults to hidden — projects that never open PRs would
  // otherwise carry a permanent, meaningless indicator on every thread.
  showThreadChangeRequestStatus: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  // Whether the thread header shows the working-tree/unpushed counters for the
  // active repository. On by default — the numbers come from the git status we
  // already stream, so there is no extra cost to displaying them.
  showGitCounts: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Per-project opt-out (or opt-in) for the header counters, keyed by the same
  // physical project key the sidebar grouping overrides use. Absent key means
  // "inherit `showGitCounts`".
  gitCountsProjectOverrides: Schema.Record(TrimmedNonEmptyString, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE)),
  ),
  sidebarProjectGroupingOverrides: Schema.Record(
    TrimmedNonEmptyString,
    SidebarProjectGroupingMode,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  sidebarThreadPreviewCount: SidebarThreadPreviewCount.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT)),
  ),
  sidebarThreadShowMoreIncrement: SidebarThreadShowMoreIncrement.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SHOW_MORE_INCREMENT)),
  ),
  systemNotificationsEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SYSTEM_NOTIFICATIONS_ENABLED)),
  ),
  systemNotifyOnTurnCompleted: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SYSTEM_NOTIFY_ON_TURN_COMPLETED)),
  ),
  systemNotifyOnInputNeeded: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SYSTEM_NOTIFY_ON_INPUT_NEEDED)),
  ),
  systemNotifyOnFailure: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SYSTEM_NOTIFY_ON_FAILURE)),
  ),
  systemNotificationsSuppressWhenFocused: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SYSTEM_NOTIFICATIONS_SUPPRESS_WHEN_FOCUSED)),
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export type ProviderSettingsFormControl = "text" | "password" | "textarea" | "switch";

export interface ProviderSettingsFormAnnotation {
  readonly control?: ProviderSettingsFormControl | undefined;
  readonly placeholder?: string | undefined;
  readonly hidden?: boolean | undefined;
  readonly clearWhenEmpty?: "omit" | "persist" | undefined;
}

export interface ProviderSettingsFormSchemaAnnotation {
  readonly order?: readonly string[] | undefined;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly providerSettingsForm?: ProviderSettingsFormAnnotation | undefined;
      readonly providerSettingsFormSchema?: ProviderSettingsFormSchemaAnnotation | undefined;
    }
  }
}

export type ProviderSettingsOrder<Fields extends Schema.Struct.Fields> = readonly Extract<
  keyof Fields,
  string
>[];

export function makeProviderSettingsSchema<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  options?: {
    readonly order?: ProviderSettingsOrder<Fields> | undefined;
  },
): Schema.Struct<Fields> {
  return Schema.Struct(fields).pipe(
    Schema.annotate({
      providerSettingsFormSchema:
        options?.order === undefined ? undefined : { order: options.order },
    }),
  );
}

export const CodexSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("codex").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Codex binary used by this instance.",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CODEX_HOME path",
        description: "Custom Codex home and config directory.",
        providerSettingsForm: {
          placeholder: "~/.codex",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    shadowHomePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Shadow home path",
        description:
          "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.",
        providerSettingsForm: {
          placeholder: "~/.codex-t3/personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "shadowHomePath"],
  },
);
export type CodexSettings = typeof CodexSettings.Type;

export const ClaudeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Claude binary used by this instance.",
        providerSettingsForm: { placeholder: "claude", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Claude HOME path",
        description:
          "Custom HOME used when running this Claude instance. Keeps .claude.json and .claude separate.",
        providerSettingsForm: { placeholder: "~", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    launchArgs: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed on session start.",
        providerSettingsForm: {
          placeholder: "e.g. --chrome",
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "launchArgs"],
  },
);
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const CursorSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("agent").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Cursor agent binary.",
        providerSettingsForm: { placeholder: "agent", clearWhenEmpty: "omit" },
      }),
    ),
    apiEndpoint: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API endpoint",
        description: "Override the Cursor API endpoint for this instance.",
        providerSettingsForm: {
          placeholder: "https://...",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "apiEndpoint"],
  },
);
export type CursorSettings = typeof CursorSettings.Type;

export const GrokSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("grok").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Grok CLI binary.",
        providerSettingsForm: { placeholder: "grok", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath"],
  },
);
export type GrokSettings = typeof GrokSettings.Type;

export const OpenCodeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("opencode").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the OpenCode binary.",
        providerSettingsForm: {
          placeholder: "opencode",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server URL",
        description: "Leave blank to let M3 Code spawn the server when needed.",
        providerSettingsForm: {
          placeholder: "http://127.0.0.1:4096",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverPassword: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server password",
        description: "Stored in plain text on disk.",
        providerSettingsForm: {
          control: "password",
          placeholder: "Optional",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "serverUrl", "serverPassword"],
  },
);
export type OpenCodeSettings = typeof OpenCodeSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL = Duration.seconds(30);

/**
 * How much of a conversation the orchestrator may touch.
 *
 * "none" is invisible to the orchestrator entirely, not merely unsendable.
 * Absent from the per-thread map means "whatever `defaultOrchestratorThreadAccess`
 * says", so the baseline is a setting and each conversation may override it in
 * either direction — tighten a thread below a permissive default, or open one up
 * above a closed one.
 */
export const OrchestratorThreadAccess = Schema.Literals(["none", "watch", "control"]);
export type OrchestratorThreadAccess = typeof OrchestratorThreadAccess.Type;

/**
 * A blanket override of everything above, set from the orchestrator's own
 * conversation rather than from the conversations being shared.
 *
 * The per-conversation model breaks down in the situation it exists for: you
 * are away from your desk, you want the orchestrator to sweep everything you
 * have going, and one of the conversations you care about was never shared —
 * possibly the one you most wanted followed up. Reaching each thread
 * individually from a phone is not a real option, and neither is
 * `defaultOrchestratorThreadAccess`, because an explicit per-thread entry wins
 * over it. This one wins over both, in either direction:
 *
 * - "per-conversation" — no override; each conversation's own setting decides.
 * - "read-shared" — everything already shared becomes read-only.
 * - "read-all" — every conversation is readable, none can be sent to.
 * - "control-all" — every conversation is readable and steerable.
 *
 * Threads in the orchestrator's own project stay excluded under every value:
 * they all hold the cross-thread tools, so opening them up would let two meta
 * conversations drive each other with nothing to stop them.
 */
export const OrchestratorAccessOverride = Schema.Literals([
  "per-conversation",
  "read-shared",
  "read-all",
  "control-all",
]);
export type OrchestratorAccessOverride = typeof OrchestratorAccessOverride.Type;
export const DEFAULT_ORCHESTRATOR_ACCESS_OVERRIDE =
  "per-conversation" as const satisfies OrchestratorAccessOverride;

export const ServerSettings = Schema.Struct({
  defaultModelEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  defaultModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  automaticGitFetchInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
    ),
  ),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("local" as const satisfies ThreadEnvMode)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  // Designates one project as the "meta" project: threads inside it are the
  // only ones granted the cross-thread orchestrator MCP tools (see
  // McpSessionRegistry.issue). `null` — the default — means no thread anywhere
  // can read or steer other threads, so this stays off until it is opted into
  // from settings.
  orchestratorProjectId: Schema.NullOr(ProjectId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // Baseline access for every conversation that has no entry in the map below.
  // Defaults to "none" so the orchestrator stays opt-in per thread; raising it
  // to "watch" or "control" flips the model to opt-out, which is what the
  // per-conversation control in the composer overrides in either direction.
  defaultOrchestratorThreadAccess: OrchestratorThreadAccess.pipe(
    Schema.withDecodingDefault(Effect.succeed("none" as const satisfies OrchestratorThreadAccess)),
  ),
  // Per-thread override of `defaultOrchestratorThreadAccess`. Keyed by
  // `ThreadId`; a missing entry means "follow the default". Written whole, like
  // `databaseConnections` — the map is small because it only holds the threads
  // the user deliberately moved off the default.
  orchestratorThreadAccess: Schema.Record(ThreadId, OrchestratorThreadAccess).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  // Blanket override of the two settings above, set from the orchestrator's own
  // composer. Defaults to "per-conversation", which changes nothing.
  orchestratorAccessOverride: OrchestratorAccessOverride.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ORCHESTRATOR_ACCESS_OVERRIDE)),
  ),
  // Models the orchestrator may pick from when it opens a new conversation.
  // Empty — the default — means it cannot choose at all and new conversations
  // inherit their project's default model, which is the safe starting point.
  // Populating it is how you let the orchestrator route work to a cheaper or a
  // stronger model, across providers, without letting it reach for anything you
  // have not sanctioned.
  orchestratorModelChoices: Schema.Array(ModelSelection).pipe(
    Schema.withDecodingDefault(
      Effect.succeed([
        {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "medium" }],
        },
        {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
        {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-6-astra",
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
      ]),
    ),
  ),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
      }),
    ),
  ),

  // Legacy single-instance-per-driver settings. Continues to be the source
  // of truth until `providerInstances` (below) lands per-driver migration
  // shims and the server starts hydrating instances from it. Driver-specific
  // schemas live here for the duration of the migration; once each driver
  // owns its config in its own package, this struct shrinks to nothing and
  // is removed entirely.
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    cursor: CursorSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    grok: GrokSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    opencode: OpenCodeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // New driver-agnostic instance map. Keyed by `ProviderInstanceId`; values
  // are `ProviderInstanceConfig` envelopes. The driver-specific config blob
  // is `Schema.Unknown` at this layer so envelopes with unknown drivers
  // (forks, downgrades, in-flight PR branches) round-trip without loss.
  // See providerInstance.ts for the forward/backward compatibility invariant.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // Postgres/Supabase connections available to the "Run SQL" action in the
  // file preview. Keyed by `DatabaseConnectionId`; the connection string is
  // held in the secret store, not here. See database.ts.
  databaseConnections: Schema.Record(DatabaseConnectionId, DatabaseConnectionConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  // Extra MCP servers mounted for the conversations of one project — a team
  // chat, a tracker, anything a project's work needs that the app does not
  // ship. Keyed by `ProjectToolServerId`; the credential is held in the secret
  // store, not here. See projectToolServers.ts.
  projectToolServers: Schema.Record(ProjectToolServerId, ProjectToolServerConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  shadowHomePath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  launchArgs: Schema.optionalKey(TrimmedString),
});

const CursorSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  apiEndpoint: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const GrokSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OpenCodeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  serverUrl: Schema.optionalKey(TrimmedString),
  serverPassword: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ServerSettingsPatch = Schema.Struct({
  defaultModelEnabled: Schema.optionalKey(Schema.Boolean),
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  // Server settings
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  addProjectBaseDirectory: Schema.optionalKey(TrimmedString),
  // Nullable so the settings UI can clear the designation; `deepMerge` assigns
  // null through, and omitting the key leaves the current value alone.
  orchestratorProjectId: Schema.optionalKey(Schema.NullOr(ProjectId)),
  defaultOrchestratorThreadAccess: Schema.optionalKey(OrchestratorThreadAccess),
  // Whole-map replacement, same rationale as `databaseConnections`: a partial
  // patch cannot express "this thread went back to following the default",
  // which is a deletion rather than a value.
  orchestratorThreadAccess: Schema.optionalKey(Schema.Record(ThreadId, OrchestratorThreadAccess)),
  // Single-entry form of the above, and the one every caller should prefer.
  //
  // Sharing is revoked by removing a key, so a whole-map write carries every
  // *other* thread's setting as collateral: a caller that read the map, did
  // something slow, and wrote it back would restore access the user revoked in
  // the meantime. This applies one key under the settings write lock, so a
  // stale read cannot resurrect a revocation. `access: null` deletes the entry,
  // putting the thread back on the default.
  orchestratorThreadAccessEntry: Schema.optionalKey(
    Schema.Struct({
      threadId: ThreadId,
      access: Schema.NullOr(OrchestratorThreadAccess),
    }),
  ),
  orchestratorAccessOverride: Schema.optionalKey(OrchestratorAccessOverride),
  // Whole-list replacement: the UI always sends the complete curated set, and a
  // merge could not express removing a model.
  orchestratorModelChoices: Schema.optionalKey(Schema.Array(ModelSelection)),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(TrimmedString),
      otlpMetricsUrl: Schema.optionalKey(TrimmedString),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
      cursor: Schema.optionalKey(CursorSettingsPatch),
      grok: Schema.optionalKey(GrokSettingsPatch),
      opencode: Schema.optionalKey(OpenCodeSettingsPatch),
    }),
  ),
  // Whole-map replacement for the new instance config. Patching individual
  // entries is intentionally out of scope: the map is small, and partial
  // patches risk leaving driver-specific config in a half-merged state.
  // The web UI sends a fully-formed map every time it edits this field.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
  // Whole-map replacement, same rationale as `providerInstances`: the map is
  // small and a partial patch could strand a connection string in the secret
  // store with no settings entry pointing at it.
  databaseConnections: Schema.optionalKey(
    Schema.Record(DatabaseConnectionId, DatabaseConnectionConfig),
  ),
  // Whole-map replacement, same rationale again: a partial patch could strand a
  // credential in the secret store with no settings entry pointing at it.
  projectToolServers: Schema.optionalKey(
    Schema.Record(ProjectToolServerId, ProjectToolServerConfig),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export const ClientSettingsPatch = Schema.Struct({
  autoOpenPlanSidebar: Schema.optionalKey(Schema.Boolean),
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  showThreadChangeRequestStatus: Schema.optionalKey(Schema.Boolean),
  showGitCounts: Schema.optionalKey(Schema.Boolean),
  gitCountsProjectOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, Schema.Boolean),
  ),
  diffIgnoreWhitespace: Schema.optionalKey(Schema.Boolean),
  diffWordWrap: Schema.optionalKey(Schema.Boolean),
  favorites: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        provider: ProviderInstanceId,
        model: TrimmedNonEmptyString,
      }),
    ),
  ),
  providerModelPreferences: Schema.optionalKey(
    Schema.Record(
      ProviderInstanceId,
      Schema.Struct({
        hiddenModels: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
        modelOrder: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
      }),
    ),
  ),
  providerUsageAlertThresholds: Schema.optionalKey(Schema.Array(ProviderUsageAlertThreshold)),
  providerUsageAlertRepeatMinutes: Schema.optionalKey(ProviderUsageAlertRepeatMinutes),
  providerUsageAlertAutoDismissSeconds: Schema.optionalKey(ProviderUsageAlertAutoDismissSeconds),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  sidebarThreadPreviewCount: Schema.optionalKey(SidebarThreadPreviewCount),
  sidebarThreadShowMoreIncrement: Schema.optionalKey(SidebarThreadShowMoreIncrement),
  timestampFormat: Schema.optionalKey(TimestampFormat),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;
