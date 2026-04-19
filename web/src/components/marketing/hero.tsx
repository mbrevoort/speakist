// Hero section. Oversized headline, short subhead, primary CTA + secondary
// link. Right side: an illustrated shortcut-keys-in-use visual implying
// "hold these keys, get text."
//
// Design intent: calm and confident, not shouty. White space is the feature.

import Link from "next/link";
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
              Private beta for macOS
            </p>

            <h1 className="mt-6 text-5xl sm:text-6xl lg:text-7xl font-semibold tracking-tight leading-[1.05] text-foreground">
              Dictation that
              <br />
              <span className="text-peach">disappears.</span>
            </h1>

            <p className="mt-6 text-lg sm:text-xl text-muted-foreground leading-relaxed max-w-xl">
              Hold a shortcut, speak, release. Clean text lands at your cursor
              in any app. No floating windows, no subscriptions you&apos;ll
              forget to cancel, no voice data stored outside your Mac.
            </p>

            <div className="mt-10 flex flex-wrap items-center gap-4">
              <Button asChild size="xl">
                <Link href="/api/auth/signin">Start with $5 free</Link>
              </Button>
              <Button asChild size="xl" variant="outline">
                <Link href="#how">See how it works</Link>
              </Button>
            </div>

            <p className="mt-6 text-sm text-muted-foreground">
              No credit card. Pay only for what you transcribe.
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
