/** Persists the operation id before rotating, so a lost response is retryable after restart. */
export interface RenewableDeviceCredential {
  readonly refreshToken: string;
  readonly accessToken: string;
  readonly accessExpiresAt: number;
  readonly pendingRequestId?: string;
}

export function createDeviceCredentialRenewer(input: {
  readonly load: () => Promise<RenewableDeviceCredential | null>;
  readonly save: (
    credential: RenewableDeviceCredential,
    expectedRefreshToken: string,
  ) => Promise<void>;
  readonly refresh: (
    credential: RenewableDeviceCredential,
    requestId: string,
  ) => Promise<RenewableDeviceCredential>;
  readonly requestId: () => string | Promise<string>;
  readonly now?: () => number;
}) {
  let pending: Promise<RenewableDeviceCredential> | undefined;
  let stopped = false;
  const renew = async () => {
    const current = await input.load();
    if (!current || stopped) throw new Error("Device authorization was removed.");
    if (!current.pendingRequestId && current.accessExpiresAt > (input.now ?? Date.now)() + 60_000)
      return current;
    const requestId = current.pendingRequestId ?? (await input.requestId());
    const prepared = { ...current, pendingRequestId: requestId };
    if (stopped) throw new Error("Device authorization was removed.");
    await input.save(prepared, current.refreshToken);
    const renewed = await input.refresh(prepared, requestId);
    if (stopped) throw new Error("Device authorization was removed.");
    await input.save(renewed, current.refreshToken);
    return renewed;
  };
  return {
    renew: () => {
      pending ??= renew().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    stop: async () => {
      stopped = true;
      await pending?.catch(() => undefined);
    },
  };
}
