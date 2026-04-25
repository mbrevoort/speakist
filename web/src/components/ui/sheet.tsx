// shadcn-style Sheet — a side-anchored Dialog. Built on
// @radix-ui/react-dialog (already a dep) so we get focus-trap, scroll
// lock, and ESC-to-close for free. We only need the left-side variant
// for the dashboard mobile nav, so the API surface is intentionally
// trimmed: no `side` prop, no header/footer subcomponents — just
// Sheet/Trigger/Content. Add variants here when a second use case
// shows up.

"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-foreground/40 backdrop-blur-sm",
      "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
      className,
    )}
    {...props}
  />
));
SheetOverlay.displayName = DialogPrimitive.Overlay.displayName;

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Hidden a11y title for screen readers. Required by Radix Dialog. */
    title?: string;
  }
>(({ className, children, title = "Menu", ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed inset-y-0 left-0 z-50 flex h-full w-72 max-w-[85vw] flex-col gap-2 border-r border-border/70 bg-background shadow-xl",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-200 data-[state=open]:duration-300",
        "data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left",
        className,
      )}
      {...props}
    >
      {/* Visually hidden title — Radix Dialog needs an accessible name
          but our drawer header carries its own visible branding. */}
      <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
      {children}
      <SheetClose
        className={cn(
          "absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        aria-label="Close menu"
      >
        <X className="h-4 w-4" />
      </SheetClose>
    </DialogPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = "SheetContent";

export { Sheet, SheetTrigger, SheetClose, SheetContent };
