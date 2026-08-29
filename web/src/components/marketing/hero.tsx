// Hero section. Local-first Mac dictation with one clear download action.
//
// Design intent: calm and confident, not shouty. White space is the feature.

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Ambient peach glow behind the headline. Fixed blur, no animation
          — calm. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 w-[1200px] h-[600px] rounded-full opacity-40 blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, rgba(255, 138, 101, 0.35), transparent)",
        }}
      />

      <div className="container relative max-w-6xl pt-20 pb-24 sm:pt-28 sm:pb-32">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_auto] gap-12 lg:gap-16 items-center">
          <div className="max-w-2xl">
            <p className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/60 px-3 py-1 text-xs font-medium text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-peach animate-pulse" />
              Private dictation for Mac
            </p>

            <h1 className="mt-6 text-5xl sm:text-6xl lg:text-7xl font-semibold tracking-tight leading-[1.05] text-foreground">
              Type at the
              <br />
              <span className="text-peach">speed of thought.</span>
            </h1>

            <p className="mt-6 text-lg sm:text-xl text-muted-foreground leading-relaxed max-w-xl">
              Hold a key, speak, and release. A speech-to-text model and a
              guarded local language model run on your Mac, then the result
              lands at your cursor in any app. No account required.
            </p>

            {/* Primary CTA on its own row — single, dominant action. The
             *  install buttons sit on a second row with platform-specific
             *  icons (download arrow for the DMG, external-link arrow for
             *  download) so the button telegraphs what'll happen on
             *  click before the user commits. */}
            <div className="mt-10 flex">
              <Button asChild size="xl">
                <a href="/api/download/mac" download className="gap-2">
                  <Download className="size-4" aria-hidden />
                  Download for Mac
                </a>
              </Button>
            </div>

            <p className="mt-6 text-sm text-muted-foreground">
              Free and unlimited. Models download once, then work
              offline. Requires an Apple silicon Mac with macOS 14+.
            </p>
          </div>

          <HeroShortcutVisual />
        </div>
      </div>
    </section>
  );
}

// Illustrated "hold these keys" visual — three keycaps depicting the default
// ⌃⌘X shortcut, with a subtle pulsing hint to signal the "hold" motion. No
// heavy animation; it's supposed to read instantly.
function HeroShortcutVisual() {
  return (
    <div
      aria-hidden
      className="relative hidden lg:flex justify-center items-center w-[360px] h-[280px]"
    >
      {/* Soft card behind the keys */}
      <div className="absolute inset-0 rounded-3xl bg-white/60 backdrop-blur-sm border border-border/50 shadow-xl" />

      <div className="relative flex items-end gap-3">
        <Keycap>⌃</Keycap>
        <Keycap>⌘</Keycap>
        <Keycap active>X</Keycap>
      </div>

      {/* Hint line: "hold + speak" */}
      <div className="absolute bottom-6 inset-x-0 text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          hold · speak · release
        </p>
      </div>
    </div>
  );
}

function Keycap({ children, active = false }: { children: React.ReactNode; active?: boolean }) {
  return (
    <div
      className={
        "relative inline-flex h-20 w-20 items-center justify-center rounded-2xl border text-3xl font-medium transition-all " +
        (active
          ? "bg-peach text-white border-peach-deep shadow-lg shadow-peach/40 animate-pulse"
          : "bg-white text-plum border-border shadow-sm")
      }
    >
      {children}
    </div>
  );
}
