// Toggle switch — visually matches the macOS / iOS Toggle aesthetic so
// the web Settings page feels consistent with the native apps. Built as
// a styled <button role="switch">; no Radix dep, no checkbox, just an
// accessible aria-checked button with a thumb that slides.
//
// Usage:
//   <Switch checked={enabled} onCheckedChange={setEnabled} />
//
// Disabled / pending state shows the slider greyed out so saves-in-flight
// don't accept a second click.

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange?: (next: boolean) => void;
  disabled?: boolean;
  /** Accessibility label — used as the button's aria-label when no
   *  surrounding <label> wraps the switch. */
  "aria-label"?: string;
  /** Class merged onto the outer track. Use for layout tweaks; the
   *  on/off colors and sizing are baked in. */
  className?: string;
  id?: string;
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, disabled, className, id, ...rest }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        aria-label={rest["aria-label"]}
        disabled={disabled}
        onClick={() => {
          if (!disabled) onCheckedChange?.(!checked);
        }}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full",
          "transition-colors duration-150 ease-out",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          checked ? "bg-peach" : "bg-input",
          disabled && "opacity-50 cursor-not-allowed",
          className
        )}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm",
            "transition-transform duration-150 ease-out",
            checked ? "translate-x-[22px]" : "translate-x-[2px]"
          )}
        />
      </button>
    );
  }
);
Switch.displayName = "Switch";
