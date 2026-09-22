import "../index.css";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { SidebarSearchButton } from "./SidebarSearchButton";
import { Sidebar, SidebarProvider, SidebarTrigger } from "./ui/sidebar";
import { Command, CommandDialog, CommandDialogPopup, CommandInput } from "./ui/command";

vi.mock("~/hooks/useMediaQuery", () => ({
  useIsMobile: () => true,
}));

function Harness() {
  const open = useCommandPaletteStore((state) => state.open);
  const setOpen = useCommandPaletteStore((state) => state.setOpen);
  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <SidebarProvider>
        <SidebarTrigger />
        <Sidebar>
          <SidebarSearchButton shortcutLabel={null} />
        </Sidebar>
      </SidebarProvider>
      <CommandDialogPopup aria-label="Search conversations">
        <Command>
          <CommandInput placeholder="Search conversations" />
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

afterEach(async () => {
  await cleanup();
  useCommandPaletteStore.getState().setOpen(false);
});

it("opens editable search from the mobile sidebar and closes the sidebar", async () => {
  await render(<Harness />);
  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await page.getByTestId("command-palette-trigger").click();
  const input = page.getByPlaceholder("Search conversations");
  await expect.element(input).toBeVisible();
  await input.fill("deployment");
  await expect.element(input).toHaveValue("deployment");
  await expect.element(page.getByTestId("command-palette-trigger")).not.toBeInTheDocument();
  expect(useCommandPaletteStore.getState().open).toBe(true);
});
