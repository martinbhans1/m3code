import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { getEnvironmentClient } from "../state/environment-session-registry";

/**
 * Signed, short-lived URLs for files the server holds — chat attachments and
 * pictures an agent saved on the desktop. The URL carries its own capability,
 * so the image loader needs no auth header. Mirrors the web's asset cache.
 */

const REFRESH_MARGIN_MS = 30_000;
const REFRESH_RETRY_MS = 15_000;

interface CachedAssetUrl {
  readonly url: string;
  readonly expiresAt: number;
}

const assetUrlCache = new Map<string, CachedAssetUrl>();
const assetUrlRequests = new Map<string, Promise<CachedAssetUrl>>();

function assetCacheKey(environmentId: EnvironmentId, resource: AssetResource): string {
  return `${environmentId}:${JSON.stringify(resource)}`;
}

export async function resolveAssetUrl(input: {
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string;
  readonly resource: AssetResource;
}): Promise<CachedAssetUrl> {
  const key = assetCacheKey(input.environmentId, input.resource);
  const cached = assetUrlCache.get(key);
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return cached;
  }
  const inFlight = assetUrlRequests.get(key);
  if (inFlight) {
    return inFlight;
  }

  const request = (async () => {
    const client = getEnvironmentClient(input.environmentId);
    if (!client) {
      throw new Error("Environment is not connected.");
    }
    const result = await client.assets.createUrl({ resource: input.resource });
    const resolved = {
      url: new URL(result.relativeUrl, input.httpBaseUrl).toString(),
      expiresAt: result.expiresAt,
    };
    assetUrlCache.set(key, resolved);
    return resolved;
  })().finally(() => {
    assetUrlRequests.delete(key);
  });
  assetUrlRequests.set(key, request);
  return request;
}

export type AssetUrlState =
  | { readonly status: "loading"; readonly url: null }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "error"; readonly url: null };

export function useAssetUrl(input: {
  readonly environmentId: EnvironmentId | null;
  readonly httpBaseUrl: string | null;
  readonly resource: AssetResource | null;
}): AssetUrlState {
  const { environmentId, httpBaseUrl } = input;
  const resourceJson = input.resource ? JSON.stringify(input.resource) : null;
  const resource = useMemo(
    () => (resourceJson ? (JSON.parse(resourceJson) as AssetResource) : null),
    [resourceJson],
  );
  const cacheKey = environmentId && resource ? assetCacheKey(environmentId, resource) : null;
  const [state, setState] = useState<AssetUrlState>(() => {
    const cached = cacheKey ? assetUrlCache.get(cacheKey) : undefined;
    return cached ? { status: "ready", url: cached.url } : { status: "loading", url: null };
  });

  useEffect(() => {
    if (!environmentId || !httpBaseUrl || !resource) {
      setState({ status: "error", url: null });
      return;
    }
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let loaded = false;

    const load = () => {
      void resolveAssetUrl({ environmentId, httpBaseUrl, resource })
        .then((result) => {
          if (cancelled) return;
          loaded = true;
          setState({ status: "ready", url: result.url });
          refreshTimer = setTimeout(
            load,
            Math.max(0, result.expiresAt - Date.now() - REFRESH_MARGIN_MS),
          );
        })
        .catch(() => {
          if (cancelled) return;
          // A refresh that fails (phone offline, reconnecting) keeps showing
          // the link that already worked and tries again shortly.
          if (loaded) {
            refreshTimer = setTimeout(load, REFRESH_RETRY_MS);
            return;
          }
          setState({ status: "error", url: null });
        });
    };
    load();

    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [environmentId, httpBaseUrl, resource]);

  return state;
}

/**
 * The server-disk path an agent's markdown image points at, or null when the
 * href is already something the phone can load (http, data:) or is relative.
 * Agents write Windows paths as `/C:/...`, `C:/...` or `file:///C:/...`.
 */
export function localImagePathFromHref(href: string): string | null {
  let value = href.trim();
  if (value.startsWith("<") && value.endsWith(">")) {
    value = value.slice(1, -1).trim();
  }
  if (/^file:\/\//i.test(value)) {
    value = value.replace(/^file:\/\/(localhost)?/i, "");
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    return null;
  }
  try {
    value = decodeURI(value);
  } catch {
    // Keep the raw text; the server rejects anything that is not a real file.
  }
  if (/^\/[a-z]:[\\/]/i.test(value)) {
    return value.slice(1);
  }
  if (/^[a-z]:[\\/]/i.test(value)) {
    return value;
  }
  // `//host` and `/\host` are network paths; never send those to the server.
  if (value.startsWith("/") && !/^\/[\\/]/.test(value)) {
    return value;
  }
  return null;
}
