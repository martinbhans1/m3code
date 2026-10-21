import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureStore from "expo-secure-store";
import { EnvironmentId, OrchestrationShellSnapshot, ServerConfig } from "@t3tools/contracts";

import {
  isRelayManagedConnection,
  type SavedRemoteConnection,
  toStableSavedRemoteConnection,
} from "./connection";

const CONNECTIONS_KEY = "t3code.connections";
const PREFERENCES_KEY = "t3code.preferences";
const AGENT_AWARENESS_DEVICE_ID_KEY = "t3code.agent-awareness.device-id";
const SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION = 1;
const SHELL_SNAPSHOT_CACHE_DIRECTORY = "shell-snapshots";

export interface CachedShellSnapshot {
  readonly schemaVersion: typeof SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION;
  readonly environmentId: EnvironmentId;
  readonly snapshotReceivedAt: string;
  readonly snapshot: OrchestrationShellSnapshot;
}

export interface MobilePreferences {
  readonly liveActivitiesEnabled?: boolean;
  readonly terminalFontSize?: number;
}

const CachedShellSnapshotSchema = Schema.Struct({
  schemaVersion: Schema.Literal(SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  snapshotReceivedAt: Schema.String,
  snapshot: OrchestrationShellSnapshot,
});
const decodeCachedShellSnapshot = Schema.decodeUnknownOption(CachedShellSnapshotSchema);

async function readStorageItem(key: string): Promise<string | null> {
  return await SecureStore.getItemAsync(key);
}

async function writeStorageItem(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

async function readJsonStorageItem<T>(key: string): Promise<T | null> {
  const raw = (await readStorageItem(key)) ?? "";
  if (!raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function cachedShellSnapshotFileName(environmentId: EnvironmentId): string {
  return `${encodeURIComponent(environmentId)}.json`;
}

async function getShellSnapshotCacheDirectory() {
  const { Directory, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, SHELL_SNAPSHOT_CACHE_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

export async function loadCachedShellSnapshot(
  environmentId: EnvironmentId,
): Promise<CachedShellSnapshot | null> {
  try {
    const { File } = await import("expo-file-system");
    const directory = await getShellSnapshotCacheDirectory();
    const file = new File(directory, cachedShellSnapshotFileName(environmentId));
    if (!file.exists) {
      return null;
    }

    const parsed = JSON.parse(await file.text()) as unknown;
    const decoded = decodeCachedShellSnapshot(parsed);
    if (Option.isNone(decoded) || decoded.value.environmentId !== environmentId) {
      return null;
    }

    return decoded.value;
  } catch {
    return null;
  }
}

export async function saveCachedShellSnapshot(
  environmentId: EnvironmentId,
  snapshot: OrchestrationShellSnapshot,
): Promise<void> {
  try {
    const { File } = await import("expo-file-system");
    const directory = await getShellSnapshotCacheDirectory();
    const file = new File(directory, cachedShellSnapshotFileName(environmentId));
    const document: CachedShellSnapshot = {
      schemaVersion: SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION,
      environmentId,
      snapshotReceivedAt: new Date().toISOString(),
      snapshot,
    };

    if (!file.exists) {
      file.create({ intermediates: true, overwrite: true });
    }
    file.write(JSON.stringify(document));
  } catch {
    // Cache persistence is best-effort and should never block live data.
  }
}

export async function clearCachedShellSnapshot(environmentId: EnvironmentId): Promise<void> {
  try {
    const { File } = await import("expo-file-system");
    const directory = await getShellSnapshotCacheDirectory();
    const file = new File(directory, cachedShellSnapshotFileName(environmentId));
    if (file.exists) {
      file.delete();
    }
  } catch {
    // Ignore cache cleanup failures.
  }
}

export async function loadSavedConnections(): Promise<ReadonlyArray<SavedRemoteConnection>> {
  const parsed = await readJsonStorageItem<{
    readonly connections?: ReadonlyArray<SavedRemoteConnection>;
  }>(CONNECTIONS_KEY);
  if (!parsed) {
    return [];
  }

  return pipe(
    parsed.connections ?? [],
    Arr.filter(
      (c) => !!c.environmentId && (!!c.bearerToken?.trim() || isRelayManagedConnection(c)),
    ),
  );
}

let connectionWrites: Promise<void> = Promise.resolve();

function serializeConnectionWrite(write: () => Promise<void>): Promise<void> {
  const pending = connectionWrites.then(write);
  connectionWrites = pending.catch(() => undefined);
  return pending;
}

export function saveConnection(connection: SavedRemoteConnection): Promise<void> {
  return serializeConnectionWrite(async () => {
    const current = await loadSavedConnections();
    const stableConnection = toStableSavedRemoteConnection(connection);
    const next = current.some((entry) => entry.environmentId === connection.environmentId)
      ? pipe(
          current,
          Arr.map((entry) =>
            entry.environmentId === connection.environmentId ? stableConnection : entry,
          ),
        )
      : pipe(current, Arr.append(stableConnection));

    await writeStorageItem(CONNECTIONS_KEY, JSON.stringify({ connections: next }));
  });
}

export function clearSavedConnection(environmentId: EnvironmentId): Promise<void> {
  return serializeConnectionWrite(async () => {
    const current = await loadSavedConnections();
    const next = pipe(
      current,
      Arr.filter((entry) => entry.environmentId !== environmentId),
    );
    await writeStorageItem(CONNECTIONS_KEY, JSON.stringify({ connections: next }));
  });
}

/** Compare and persist rotation together so removal/re-pairing cannot be overwritten. */
export function updateDeviceCredential(
  environmentId: EnvironmentId,
  expectedRefreshToken: string,
  credential: Pick<
    SavedRemoteConnection,
    "bearerToken" | "deviceRefreshToken" | "accessExpiresAt" | "deviceRefreshRequestId"
  >,
): Promise<void> {
  return serializeConnectionWrite(async () => {
    const connections = await loadSavedConnections();
    const stored = connections.find((entry) => entry.environmentId === environmentId);
    if (!stored || stored.deviceRefreshToken !== expectedRefreshToken) {
      throw new Error("Device authorization was removed or replaced.");
    }
    const { deviceRefreshRequestId: _, ...base } = stored;
    const next = connections.map((entry) =>
      entry.environmentId === environmentId ? { ...base, ...credential } : entry,
    );
    await writeStorageItem(CONNECTIONS_KEY, JSON.stringify({ connections: next }));
  });
}

export async function loadPreferences(): Promise<MobilePreferences> {
  const parsed = await readJsonStorageItem<MobilePreferences>(PREFERENCES_KEY);
  if (!parsed || typeof parsed !== "object") {
    return {};
  }

  const preferences: {
    liveActivitiesEnabled?: boolean;
    terminalFontSize?: number;
  } = {};

  if (typeof parsed.liveActivitiesEnabled === "boolean") {
    preferences.liveActivitiesEnabled = parsed.liveActivitiesEnabled;
  }
  if (typeof parsed.terminalFontSize === "number") {
    preferences.terminalFontSize = parsed.terminalFontSize;
  }

  return preferences;
}

export async function savePreferencesPatch(
  patch: Partial<MobilePreferences>,
): Promise<MobilePreferences> {
  const current = await loadPreferences();
  const next: MobilePreferences = {
    ...current,
    ...patch,
  };
  await writeStorageItem(PREFERENCES_KEY, JSON.stringify(next));
  return next;
}

export async function loadOrCreateAgentAwarenessDeviceId(): Promise<string> {
  const existing = await readStorageItem(AGENT_AWARENESS_DEVICE_ID_KEY);
  if (existing?.trim()) {
    return existing;
  }

  const { uuidv4 } = await import("./uuid");
  const deviceId = uuidv4();
  await writeStorageItem(AGENT_AWARENESS_DEVICE_ID_KEY, deviceId);
  return deviceId;
}

export async function loadAgentAwarenessDeviceId(): Promise<string | null> {
  const existing = await readStorageItem(AGENT_AWARENESS_DEVICE_ID_KEY);
  return existing?.trim() ? existing : null;
}

// The computer's settings and model list, kept so a relaunched or woken phone
// can show the model picker at once instead of waiting for the connection.
// Same best-effort file cache as the shell snapshot; a version bump or a
// schema change just reads as "nothing cached".
const SERVER_CONFIG_CACHE_DIRECTORY = "server-configs";
const decodeCachedServerConfig = Schema.decodeUnknownOption(ServerConfig);

async function getServerConfigCacheFile(environmentId: EnvironmentId) {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, SERVER_CONFIG_CACHE_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, `${encodeURIComponent(environmentId)}.json`);
}

export async function loadCachedServerConfig(
  environmentId: EnvironmentId,
): Promise<ServerConfig | null> {
  try {
    const file = await getServerConfigCacheFile(environmentId);
    if (!file.exists) return null;
    const decoded = decodeCachedServerConfig(JSON.parse(await file.text()) as unknown);
    return Option.isSome(decoded) && decoded.value.environment.environmentId === environmentId
      ? decoded.value
      : null;
  } catch {
    return null;
  }
}

export async function saveCachedServerConfig(
  environmentId: EnvironmentId,
  config: ServerConfig,
): Promise<void> {
  try {
    const file = await getServerConfigCacheFile(environmentId);
    if (!file.exists) file.create({ intermediates: true, overwrite: true });
    file.write(JSON.stringify(config));
  } catch {
    // Best-effort, like the shell snapshot cache.
  }
}

export async function clearCachedServerConfig(environmentId: EnvironmentId): Promise<void> {
  try {
    const file = await getServerConfigCacheFile(environmentId);
    if (file.exists) file.delete();
  } catch {
    // Ignore cache cleanup failures.
  }
}
