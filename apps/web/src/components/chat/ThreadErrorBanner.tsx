import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CheckIcon, CircleAlertIcon, CopyIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  if (!error) return null;
  const copyLabel = isCopied ? "Copied error" : "Copy error";
  return (
    <div className="pt-3 mx-auto w-full max-w-3xl px-3">
      <Alert variant="error">
        <CircleAlertIcon />
        {/* AlertDescription has to be the direct child of Alert - that is how
            Alert routes it into the full-width content column rather than the
            icon slot. The tooltip goes inside it, not around it. */}
        <AlertDescription>
          <Tooltip>
            <TooltipTrigger
              render={<div className="line-clamp-3 min-w-0 break-words whitespace-pre-wrap" />}
            >
              {error}
            </TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {error}
            </TooltipPopup>
          </Tooltip>
        </AlertDescription>
        <AlertAction>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={copyLabel}
                  onClick={() => copyToClipboard(error)}
                />
              }
            >
              {isCopied ? (
                <CheckIcon className="text-success" />
              ) : (
                <CopyIcon className="text-destructive" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
          {onDismiss && (
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
              <XIcon className="text-destructive" />
            </Button>
          )}
        </AlertAction>
      </Alert>
    </div>
  );
});
