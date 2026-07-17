import { memo } from "react";

import { getProviderUsageSummary } from "../settings/providerStatus";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ProviderUsageBody } from "./ProviderUsagePanel";
import type { ProviderInstanceEntry } from "../../providerInstances";

/**
 * `/usage` — plan usage for every configured provider at once.
 *
 * The hover meter answers "how much of *this* provider is left"; this answers
 * the question that motivated the feature, which is not having to visit each
 * provider to find out. So it lists every instance, including the ones with
 * nothing to report — an absent row would read as "not configured" rather
 * than "no plan limits", which is the opposite of informative.
 */
export const ProviderUsageDialog = memo(function ProviderUsageDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Same instance list the composer's provider picker renders. */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
}) {
  // One clock for the whole dialog so every row's countdown is consistent
  // with its neighbours.
  const now = Date.now();

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Plan usage</DialogTitle>
          <DialogDescription>
            Subscription limits reported by each configured provider.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-5">
          {props.instanceEntries.length === 0 ? (
            <div className="text-muted-foreground text-sm">No providers are configured.</div>
          ) : (
            props.instanceEntries.map((entry) => {
              const summary = getProviderUsageSummary(entry.snapshot, now);
              const planLabel = summary.kind === "measured" ? summary.planLabel : null;
              return (
                <section key={entry.instanceId} className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <ProviderInstanceIcon
                      driverKind={entry.driverKind}
                      displayName={entry.displayName}
                      accentColor={entry.accentColor}
                      className="size-4"
                      iconClassName="size-4"
                    />
                    <span className="min-w-0 truncate font-medium text-sm">
                      {entry.displayName}
                    </span>
                    {planLabel ? (
                      <span className="shrink-0 text-muted-foreground/70 text-xs">{planLabel}</span>
                    ) : null}
                  </div>
                  <ProviderUsageBody summary={summary} />
                </section>
              );
            })
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
});
