import { type ServerProvider } from "@t3tools/contracts";
import { memo, useEffect, useMemo, useState } from "react";
import { InfoIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  const dismissalKey = useMemo(
    () =>
      status && status.status !== "ready" && status.status !== "disabled"
        ? [
            status.instanceId,
            status.status,
            status.auth.status,
            status.installed ? "installed" : "missing",
            status.version ?? "",
            status.message ?? "",
          ].join("\u0000")
        : null,
    [status],
  );
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => {
    if (dismissedKey !== null && dismissedKey !== dismissalKey) {
      setDismissedKey(null);
    }
  }, [dismissalKey, dismissedKey]);

  if (!status || dismissalKey === null || dismissalKey === dismissedKey) {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const isUnauthenticated = status.status === "error" && status.auth.status === "unauthenticated";
  const title = isUnauthenticated
    ? `${providerName} is unauthenticated`
    : `${providerName} provider status`;
  const message = isUnauthenticated
    ? "Open Settings → Providers and choose Sign in to authenticate again."
    : (status.message ??
      (status.status === "error"
        ? `${providerName} provider is unavailable.`
        : `${providerName} provider has limited availability.`));

  return (
    <div className="mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <div
        className={cn(
          "inline-flex items-center gap-3 rounded-xl border px-3.5 py-3 text-card-foreground text-sm",
          status.status === "warning"
            ? "border-warning/32 bg-warning/4 [&_svg]:text-warning"
            : "border-destructive/32 bg-destructive/4 text-destructive-foreground [&_svg]:text-destructive",
        )}
        role="alert"
      >
        <InfoIcon className="size-4 shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="font-medium">{title}</div>
          <Tooltip>
            <TooltipTrigger
              render={<div className="line-clamp-3 text-muted-foreground">{message}</div>}
            />
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {message}
            </TooltipPopup>
          </Tooltip>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Dismiss provider status"
                onClick={() => setDismissedKey(dismissalKey)}
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">Dismiss until provider status changes</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});
