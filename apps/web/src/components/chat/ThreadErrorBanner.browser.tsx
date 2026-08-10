import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

const ERROR =
  "Provider runtime error: the agent process exited unexpectedly while applying " +
  "patch to apps/web/src/components/ChatView.tsx. Check the provider logs for details.";

describe("ThreadErrorBanner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("gives the message the full width of the banner instead of squeezing it beside the actions", async () => {
    await page.viewport(900, 600);
    const screen = await render(<ThreadErrorBanner error={ERROR} onDismiss={vi.fn()} />);

    try {
      const alert = document.querySelector('[data-slot="alert"]');
      const description = document.querySelector('[data-slot="alert-description"]');
      expect(alert).not.toBeNull();
      expect(description).not.toBeNull();

      const alertWidth = alert!.getBoundingClientRect().width;
      const descriptionWidth = description!.getBoundingClientRect().width;

      // The regression put the description inside the alert's 16px icon slot,
      // which wrapped the message to a couple of characters per line and left
      // the rest of the banner empty.
      expect(alertWidth).toBeGreaterThan(400);
      expect(descriptionWidth).toBeGreaterThan(alertWidth * 0.7);

      // Actions stay pinned to the right-hand end of the banner.
      const dismiss = document.querySelector('[aria-label="Dismiss error"]');
      const dismissRect = dismiss!.getBoundingClientRect();
      const alertRect = alert!.getBoundingClientRect();
      expect(alertRect.right - dismissRect.right).toBeLessThan(24);
    } finally {
      await screen.unmount();
    }
  });

  it("still renders the leading icon in the icon slot", async () => {
    const screen = await render(<ThreadErrorBanner error={ERROR} onDismiss={vi.fn()} />);
    try {
      await expect.element(page.getByRole("alert")).toBeVisible();
      expect(document.querySelector('[data-slot="alert"] svg')).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
