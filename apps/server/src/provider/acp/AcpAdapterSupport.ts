import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/** `data` is agent-controlled and ends up persisted on the thread error event, so cap it —
 * some agents echo the whole failing request (prompt, file contents) back in this field. */
const ACP_ERROR_DATA_MAX_CHARS = 500;

function stringifyErrorData(data: unknown): string | undefined {
  let text: string | undefined;
  if (typeof data === "string") {
    text = data;
  } else {
    try {
      text = JSON.stringify(data);
    } catch {
      return undefined;
    }
  }
  const trimmed = text?.trim();
  if (!trimmed || trimmed === "{}" || trimmed === "[]" || trimmed === "null") {
    return undefined;
  }
  return trimmed.length > ACP_ERROR_DATA_MAX_CHARS
    ? `${trimmed.slice(0, ACP_ERROR_DATA_MAX_CHARS)}…`
    : trimmed;
}

/** JSON-RPC keeps the human-meaningful reason in `data` ("unknown model id") while `message`
 * stays a generic code label ("Invalid params"), so surfacing only `message` strands the
 * one piece of text that explains the failure. */
function acpRequestErrorDetail(error: EffectAcpErrors.AcpRequestError): string {
  if (error.data === undefined || error.data === null) {
    return error.message;
  }
  const data = stringifyErrorData(error.data);
  return data && data !== error.message ? `${error.message}: ${data}` : error.message;
}

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (isAcpRequestError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: acpRequestErrorDetail(error),
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}
