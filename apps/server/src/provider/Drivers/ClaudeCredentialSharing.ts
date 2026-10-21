/**
 * ClaudeCredentialSharing — telling an instance that its sign-in is not its own.
 *
 * Claude issues a fresh refresh token on every refresh and cancels the one it
 * replaced, and it serialises that refresh behind a lock kept inside the config
 * dir. Two config dirs whose credentials file resolves to one path therefore
 * hold two copies of a single rotating token behind two locks that cannot see
 * each other. The second one to refresh is answered with `invalid_grant`, and
 * Claude's response to a dead refresh token is to blank the tokens in the file
 * it read them from — which signs out every account pointed at that file, with
 * no hint as to why.
 *
 * Two shapes of that fault are worth reporting, and they are not the same:
 *
 *   - **A sibling instance.** Two enabled Claude instances in this app resolve
 *     to one credentials file. The app owns both, so it can name them.
 *   - **A store outside the instance's own config dir.** The file is a symlink
 *     (or the config dir is shared) pointing somewhere this app does not
 *     manage: Claude Desktop's `~/.claude`, a plain `claude` CLI, another tool
 *     entirely. Nothing in the registry can see that peer, which is exactly why
 *     it has to be reported as a property of the path rather than inferred from
 *     the other instances.
 *
 * This module is pure. Resolving the paths belongs to `ClaudeHome`, holding
 * them to `ClaudeCredentialStoreRegistry`, and reporting them to the driver.
 *
 * @module provider/Drivers/ClaudeCredentialSharing
 */
import type { ProviderInstanceId } from "@t3tools/contracts";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";

import type { ServerProviderDraft } from "../providerSnapshot.ts";

/** Where one enabled Claude instance keeps its sign-in, symlinks resolved. */
export interface ClaudeCredentialStoreLocation {
  /** The instance's own config dir, resolved. */
  readonly configDirPath: string;
  /** The credentials file that dir actually reads, resolved. */
  readonly credentialsPath: string;
}

/** A located instance, as the registry hands it to the comparison below. */
export interface ClaudeCredentialStoreClaim extends ClaudeCredentialStoreLocation {
  readonly instanceId: ProviderInstanceId;
  /** What to call this instance when naming it to the user. */
  readonly label: string;
}

export interface ClaudeCredentialSharing {
  /** Labels of the other enabled instances reading the same file. */
  readonly sharedWith: ReadonlyArray<string>;
  /** The file, when it sits outside the instance's own config dir. */
  readonly storePathOutsideConfigDir: string | undefined;
}

/**
 * Compare two paths the way the filesystem that produced them would.
 *
 * Windows paths are matched case-insensitively and separator-insensitively;
 * everything else is matched exactly, because a POSIX filesystem really can
 * hold two files whose names differ only in case.
 */
export function isSameResolvedPath(left: string, right: string): boolean {
  if (isWindowsAbsolutePath(left) || isWindowsAbsolutePath(right)) {
    const normalize = (value: string) => value.replaceAll("\\", "/").toLowerCase();
    return normalize(left) === normalize(right);
  }
  return left === right;
}

function directoryOf(filePath: string): string {
  const separator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return separator <= 0 ? filePath : filePath.slice(0, separator);
}

/**
 * What this instance is sharing its sign-in with, or `undefined` when the
 * sign-in is its own.
 */
export function findClaudeCredentialSharing(input: {
  readonly claim: ClaudeCredentialStoreClaim;
  readonly others: ReadonlyArray<ClaudeCredentialStoreClaim>;
}): ClaudeCredentialSharing | undefined {
  const { claim, others } = input;
  const sharedWith = others
    .filter(
      (other) =>
        other.instanceId !== claim.instanceId &&
        isSameResolvedPath(other.credentialsPath, claim.credentialsPath),
    )
    .map((other) => other.label);

  const storePathOutsideConfigDir = isSameResolvedPath(
    directoryOf(claim.credentialsPath),
    claim.configDirPath,
  )
    ? undefined
    : claim.credentialsPath;

  if (sharedWith.length === 0 && storePathOutsideConfigDir === undefined) return undefined;
  return { sharedWith, storePathOutsideConfigDir };
}

function formatLabelList(labels: ReadonlyArray<string>): string {
  const quoted = labels.map((label) => `"${label}"`);
  if (quoted.length <= 1) return quoted.join("");
  const last = quoted[quoted.length - 1];
  return `${quoted.slice(0, -1).join(", ")} and ${last}`;
}

/**
 * The warning the user reads. Names what is shared, says what breaks, and ends
 * on the one change that fixes it — a reader who skims the first clause should
 * still come away knowing the two accounts will sign each other out.
 */
export function formatClaudeCredentialSharingMessage(sharing: ClaudeCredentialSharing): string {
  const what =
    sharing.sharedWith.length > 0
      ? `This account shares one Claude sign-in with ${formatLabelList(sharing.sharedWith)}.`
      : `This account signs in through a file outside its own folder (${sharing.storePathOutsideConfigDir}), so it shares that sign-in with whatever else reads it — Claude Desktop, the \`claude\` CLI, another tool.`;
  return `${what} Claude replaces its login token on every refresh and cancels the old one, so whichever side refreshes second is rejected, and that rejection clears the shared login for both. Give each account its own CLAUDE_CONFIG_DIR with its own credentials file, and sign in to each separately.`;
}

/**
 * Fold the warning into a snapshot.
 *
 * A failing probe keeps its `error` status and leads with its own message: a
 * signed-out instance is usually this fault's *symptom*, and the explanation
 * reads better after the symptom than in front of it. A disabled instance is
 * left alone entirely — it refreshes nothing, so it collides with nothing.
 */
export function withClaudeCredentialSharing(
  snapshot: ServerProviderDraft,
  sharing: ClaudeCredentialSharing | undefined,
): ServerProviderDraft {
  if (!sharing || snapshot.status === "disabled") return snapshot;
  const warning = formatClaudeCredentialSharingMessage(sharing);
  return {
    ...snapshot,
    status: snapshot.status === "error" ? "error" : "warning",
    message: snapshot.message ? `${snapshot.message} ${warning}` : warning,
  };
}
