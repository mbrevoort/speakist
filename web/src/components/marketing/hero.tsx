// Hero section. Oversized headline, short subhead, primary CTA + per-
// platform download buttons. Right side: an illustrated shortcut-keys-in-
// use visual implying "hold these keys, get text" — works as a metaphor
// for both the Mac shortcut and the iOS keyboard's hold-to-talk gesture.
//
// Design intent: calm and confident, not shouty. White space is the feature.

import Link from "next/link";
import { Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

// TestFlight invite for the iOS beta. External so it opens in a new tab.
const IOS_TESTFLIGHT_URL = "https://testflight.apple.com/join/5jqHKMnu";

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
              Beta for Mac and iPhone
            </p>

            <h1 className="mt-6 text-5xl sm:text-6xl lg:text-7xl font-semibold tracking-tight leading-[1.05] text-foreground">
              Type at the
              <br />
              <span className="text-peach">speed of thought.</span>
            </h1>

            <p className="mt-6 text-lg sm:text-xl text-muted-foreground leading-relaxed max-w-xl">
              You speak about 3× faster than you type — yet built-in Mac and
              iOS dictation makes you wish you&apos;d just typed. Speakist
              actually works: hold a key on Mac or use the Speakist iOS
              keyboard, and clean text lands at your cursor in any app — for
              half the price of a subscription.
            </p>

            {/* Primary CTA on its own row — single, dominant action. The
             *  install buttons sit on a second row with platform-specific
             *  icons (download arrow for the DMG, external-link arrow for
             *  TestFlight) so each button telegraphs what'll happen on
             *  click before the user commits. */}
            <div className="mt-10 flex">
              <Button asChild size="xl">
                <Link href="/auth/signin">Start with 3,000 free words</Link>
              </Button>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button asChild size="lg" variant="outline">
                {/* /api/download/mac 302s to the latest stable DMG on R2.
                    Direct link — no signin required for installing; the
                    account flow happens on first launch. */}
                <a href="/api/download/mac" download className="gap-2">
                  <Download className="size-4" aria-hidden />
                  Download for Mac
                </a>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a
                  href={IOS_TESTFLIGHT_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="gap-2"
                >
                  iPhone Beta (TestFlight)
                  <ExternalLink className="size-4" aria-hidden />
                </a>
              </Button>
            </div>

            <p className="mt-6 text-sm text-muted-foreground">
              No credit card. No subscription. Pay only for what you transcribe.
              Requires macOS 14+ or iOS 17+.
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
