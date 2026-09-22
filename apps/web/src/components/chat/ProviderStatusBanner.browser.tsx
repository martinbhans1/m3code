import "../../index.css";

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { ProviderStatusBanner } from "./ProviderStatusBanner";

const WARNING: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  enabled: true,
  installed: true,
  version: "2.1.169",
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-08-11T07:00:00.000Z",
  message: "Provider status could not be verified.",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("ProviderStatusBanner", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("can be dismissed until the substantive provider status changes", async () => {
    const screen = await render(<ProviderStatusBanner status={WARNING} />);

    await expect.element(page.getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "Dismiss provider status" }).click();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();

    await screen.rerender(
      <ProviderStatusBanner status={{ ...WARNING, checkedAt: "2026-08-11T07:01:00.000Z" }} />,
    );
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();

    await screen.rerender(
      <ProviderStatusBanner status={{ ...WARNING, message: "Provider is unavailable." }} />,
    );
    await expect.element(page.getByRole("alert")).toBeVisible();
  });
});
