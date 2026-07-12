"use client";

import { PipetteIcon } from "lucide-react";
import { type CSSProperties } from "react";

import { ProviderCustomColorPanel } from "./ProviderAccentColorPicker";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { cn } from "../../lib/utils";

/** A spread of pleasant hues to one-click the sidebar/header tint. */
const CHROME_TINT_PRESETS = [
  { label: "Indigo", value: "#6366f1" },
  { label: "Violet", value: "#8b5cf6" },
  { label: "Sky", value: "#0ea5e9" },
  { label: "Teal", value: "#14b8a6" },
  { label: "Emerald", value: "#22c55e" },
  { label: "Amber", value: "#f59e0b" },
  { label: "Rose", value: "#f43f5e" },
] as const;

const DEFAULT_CUSTOM_SEED = "#6366f1";

function selectedRing(color: string): CSSProperties {
  return { boxShadow: `inset 0 0 0 2px var(--card), 0 0 0 2px ${color}` };
}

export function SidebarTintControl(props: {
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
}) {
  const { onChange, value } = props;
  const normalized = value?.toLowerCase() ?? null;
  const isPreset = Boolean(
    normalized && CHROME_TINT_PRESETS.some((preset) => preset.value === normalized),
  );
  const isCustom = Boolean(normalized && !isPreset);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(null)}
        className={cn(
          "h-6 cursor-pointer rounded-full border border-border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground",
          !normalized && "border-ring text-foreground",
        )}
        aria-pressed={!normalized}
        aria-label="Use the theme's default chrome color"
      >
        Auto
      </button>

      {CHROME_TINT_PRESETS.map((preset) => (
        <button
          key={preset.value}
          type="button"
          onClick={() => onChange(preset.value)}
          className="size-6 cursor-pointer rounded-full transition-transform duration-200 hover:scale-105 active:scale-90"
          style={{
            backgroundColor: preset.value,
            ...(normalized === preset.value ? selectedRing(preset.value) : {}),
          }}
          aria-pressed={normalized === preset.value}
          aria-label={`Tint the sidebar and header ${preset.label.toLowerCase()}`}
        />
      ))}

      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="flex size-6 cursor-pointer items-center justify-center rounded-full text-white transition-transform duration-200 hover:scale-105 active:scale-90"
              style={{
                backgroundColor: isCustom ? (normalized as string) : "var(--muted)",
                ...(isCustom ? selectedRing(normalized as string) : {}),
              }}
              aria-label="Pick a custom sidebar and header tint"
            >
              <PipetteIcon
                className={cn("size-3", isCustom ? "text-white/70" : "text-foreground/40")}
                aria-hidden
              />
            </button>
          }
        />
        <PopoverPopup
          side="bottom"
          align="end"
          sideOffset={6}
          className="overflow-hidden rounded-md p-0 [--viewport-inline-padding:0px] [&_[data-slot=popover-viewport]]:p-0"
        >
          <ProviderCustomColorPanel
            value={normalized ?? DEFAULT_CUSTOM_SEED}
            onCommit={(color) => onChange(color)}
          />
        </PopoverPopup>
      </Popover>
    </div>
  );
}
