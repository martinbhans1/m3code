import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection, getDefaultModelSelection } from "./model.ts";
import {
  applyServerSettingsPatch,
  extractPersistedServerObservabilitySettings,
  normalizePersistedServerSettingString,
  parsePersistedServerObservabilitySettings,
} from "./serverSettings.ts";

describe("serverSettings helpers", () => {
  it("retains the chosen default while disabled and replaces options when switching models", () => {
    const selection = createModelSelection(
      ProviderInstanceId.make("claude-personal"),
      "claude-opus-5-5",
      [{ id: "effort", value: "high" }],
    );
    const enabled = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultModelEnabled: true,
      defaultModelSelection: selection,
    });
    expect(getDefaultModelSelection(enabled)).toEqual(selection);
    const disabled = applyServerSettingsPatch(enabled, { defaultModelEnabled: false });
    expect(getDefaultModelSelection(disabled)).toBeNull();
    expect(disabled.defaultModelSelection).toEqual(selection);
    const replacement = createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra");
    expect(
      applyServerSettingsPatch(enabled, { defaultModelSelection: replacement })
        .defaultModelSelection,
    ).toEqual(replacement);
    expect(
      applyServerSettingsPatch(enabled, { defaultModelSelection: null }).defaultModelSelection,
    ).toBeNull();
    expect(getDefaultModelSelection(DEFAULT_SERVER_SETTINGS)).toBeNull();
  });

  it("normalizes optional persisted strings", () => {
    expect(normalizePersistedServerSettingString(undefined)).toBeUndefined();
    expect(normalizePersistedServerSettingString("   ")).toBeUndefined();
    expect(normalizePersistedServerSettingString("  http://localhost:4318/v1/traces  ")).toBe(
      "http://localhost:4318/v1/traces",
    );
  });

  it("extracts persisted observability settings", () => {
    expect(
      extractPersistedServerObservabilitySettings({
        observability: {
          otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
          otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
        },
      }),
    ).toEqual({
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpMetricsUrl: "http://localhost:4318/v1/metrics",
    });
  });

  it("parses lenient persisted settings JSON", () => {
    expect(
      parsePersistedServerObservabilitySettings(
        JSON.stringify({
          observability: {
            otlpTracesUrl: "http://localhost:4318/v1/traces",
            otlpMetricsUrl: "http://localhost:4318/v1/metrics",
          },
        }),
      ),
    ).toEqual({
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpMetricsUrl: "http://localhost:4318/v1/metrics",
    });
  });

  it("falls back cleanly when persisted settings are invalid", () => {
    expect(parsePersistedServerObservabilitySettings("{")).toEqual({
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
    });
  });

  it("replaces text generation selection when provider/model are provided", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("still deep merges text generation selection when only options are provided", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: false },
      ],
    });
  });

  it("replaces text generation selection across providers without leaking stale options", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
    });
  });

  it("accepts array-based text generation selection patches", () => {
    expect(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
          options: [
            { id: "variant", value: "prod" },
            { id: "agent", value: "build" },
          ],
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
      options: [
        { id: "variant", value: "prod" },
        { id: "agent", value: "build" },
      ],
    });
  });

  it("replaces providerInstances maps so omitted instance fields are cleared", () => {
    const codexId = ProviderInstanceId.make("codex");
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Codex Work",
          accentColor: "#7c3aed",
          enabled: true,
          config: { homePath: "~/.codex" },
        },
      },
    };

    expect(
      applyServerSettingsPatch(current, {
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      }).providerInstances[codexId],
    ).toEqual({
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex Work",
      enabled: true,
      config: { homePath: "~/.codex" },
    });
  });

  it("sets and clears one thread's orchestrator access without touching the others", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      orchestratorThreadAccess: { "thread-a": "control", "thread-b": "watch" },
    } as typeof DEFAULT_SERVER_SETTINGS;

    // Setting one entry leaves every other thread's setting alone.
    expect(
      applyServerSettingsPatch(current, {
        orchestratorThreadAccessEntry: { threadId: "thread-c", access: "watch" },
      } as never).orchestratorThreadAccess,
    ).toEqual({ "thread-a": "control", "thread-b": "watch", "thread-c": "watch" });

    // A null access deletes the key, which puts the thread back on the default
    // rather than closing it.
    expect(
      applyServerSettingsPatch(current, {
        orchestratorThreadAccessEntry: { threadId: "thread-a", access: null },
      } as never).orchestratorThreadAccess,
    ).toEqual({ "thread-b": "watch" });

    // An explicit "none" is a value, not a deletion: it holds the conversation
    // closed even when the default is open.
    expect(
      applyServerSettingsPatch(current, {
        orchestratorThreadAccessEntry: { threadId: "thread-a", access: "none" },
      } as never).orchestratorThreadAccess,
    ).toEqual({ "thread-a": "none", "thread-b": "watch" });

    // The whole-map form still replaces wholesale, and the entry form wins when
    // a patch carries both.
    expect(
      applyServerSettingsPatch(current, {
        orchestratorThreadAccess: { "thread-z": "control" },
        orchestratorThreadAccessEntry: { threadId: "thread-z", access: null },
      } as never).orchestratorThreadAccess,
    ).toEqual({});
  });
});
