import { SearchIcon } from "lucide-react";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { SidebarMenuButton, useSidebar } from "./ui/sidebar";
import { Kbd } from "./ui/kbd";

export function SidebarSearchButton({ shortcutLabel }: { shortcutLabel: string | null }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const setSearchOpen = useCommandPaletteStore((store) => store.setOpen);
  // A dialog trigger here would bind to the mobile sidebar's Sheet root.
  return (
    <SidebarMenuButton
      size="sm"
      className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:ring-0"
      data-testid="command-palette-trigger"
      onClick={() => {
        if (isMobile) setOpenMobile(false);
        setSearchOpen(true);
      }}
    >
      <SearchIcon className="size-3.5 text-muted-foreground/70" />
      <span className="flex-1 truncate text-left text-xs">Search</span>
      {shortcutLabel ? (
        <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px]">{shortcutLabel}</Kbd>
      ) : null}
    </SidebarMenuButton>
  );
}
