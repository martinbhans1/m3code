import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";

const trimNonEmptyOption = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

const trimmedString = (name: string) =>
  Config.string(name).pipe(Config.option, Config.map(Option.flatMap(trimNonEmptyOption)));

const booleanWithDefault = (name: string, fallback: boolean) =>
  Config.boolean(name).pipe(Config.option, Config.map(Option.getOrElse(() => fallback)));

const optionalBoolean = (name: string) => booleanWithDefault(name, false);

const commaSeparatedStrings = (name: string) =>
  trimmedString(name).pipe(
    Config.map(
      Option.match({
        onNone: () => [],
        onSome: (value) =>
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
      }),
    ),
  );

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const DesktopConfig = Config.all({
  appDataDirectory: trimmedString("APPDATA"),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  t3Home: trimmedString("T3CODE_HOME"),
  devServerUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option),
  devIsolatedState: optionalBoolean("T3CODE_DEV_ISOLATED_STATE"),
  appUserModelIdOverride: trimmedString("T3CODE_DESKTOP_APP_USER_MODEL_ID"),
  devRemoteT3ServerEntryPath: trimmedString("T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH"),
  configuredBackendPort: Config.port("T3CODE_PORT").pipe(Config.option),
  commitHashOverride: trimmedString("T3CODE_COMMIT_HASH"),
  desktopLanHostOverride: trimmedString("T3CODE_DESKTOP_LAN_HOST"),
  desktopHttpsEndpointUrls: commaSeparatedStrings("T3CODE_DESKTOP_HTTPS_ENDPOINTS"),
  otlpTracesUrl: trimmedString("T3CODE_OTLP_TRACES_URL"),
  otlpExportIntervalMs: Config.int("T3CODE_OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.withDefault(10_000),
  ),
  appImagePath: trimmedString("APPIMAGE"),
  // m3code fork: auto-update is disabled by DEFAULT (upstream defaults it to off).
  // Upstream builds bake pingdotgg/t3code into app-update.yml, so leaving updates on
  // would let the pill offer (and install) vanilla T3 Code over this fork, and we
  // publish no releases of our own. Nothing in the packaged app sets this variable, so
  // real users always get updates off; `T3CODE_DISABLE_AUTO_UPDATE=false` is a
  // deliberate opt-in used by the updater tests against the mock feed.
  disableAutoUpdate: booleanWithDefault("T3CODE_DISABLE_AUTO_UPDATE", true),
  mockUpdates: optionalBoolean("T3CODE_DESKTOP_MOCK_UPDATES"),
  mockUpdateServerPort: Config.port("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(
    Config.withDefault(3000),
  ),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
