import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import { acpPermissionOutcome, mapAcpToAdapterError } from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });

  const requestErrorDetail = (data: unknown): string => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("grok"),
      "thread-1" as never,
      "session/set_model",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
        ...(data !== undefined ? { data } : {}),
      }),
    );
    if (error._tag !== "ProviderAdapterRequestError") {
      throw new Error(`Expected ProviderAdapterRequestError, got ${error._tag}`);
    }
    return error.detail;
  };

  it("surfaces the JSON-RPC data field, which carries the actual reason", () => {
    // The Grok CLI rejects an unavailable model with message "Invalid params" and
    // data "unknown model id" — only the latter explains the failure.
    expect(requestErrorDetail("unknown model id")).toBe("Invalid params: unknown model id");
  });

  it("leaves the detail alone when data adds nothing", () => {
    expect(requestErrorDetail(undefined)).toBe("Invalid params");
    expect(requestErrorDetail(null)).toBe("Invalid params");
    expect(requestErrorDetail("   ")).toBe("Invalid params");
    expect(requestErrorDetail({})).toBe("Invalid params");
    expect(requestErrorDetail("Invalid params")).toBe("Invalid params");
  });

  it("caps agent-controlled data so it cannot bloat the persisted thread error", () => {
    const detail = requestErrorDetail("x".repeat(5_000));
    expect(detail.length).toBeLessThan(600);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("does not throw on data that cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(requestErrorDetail(circular)).toBe("Invalid params");
  });
});
