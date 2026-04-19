// Shared shell for /auth/* pages. Centered card on a cream-peach gradient
// background, Speakist wordmark on top, tiny "back to home" footer beneath.
// Each auth page drops its content into the card via `children`.

import Link from "next/link";
import { Wordmark } from "@/components/brand/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center px-4 py-12">
      {/* Ambient peach glow — same device the hero uses, calmer */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] opacity-50 blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse at top, rgba(255, 138, 101, 0.25), transparent 70%)",
        }}
      />

      <div className="relative flex flex-col items-center w-full max-w-md">
        <Link href="/" aria-label="Speakist home" className="mb-8">
          <Wordmark markClassName="w-8 h-8" className="text-xl" />
        </Link>

        <div className="w-full rounded-2xl border border-border/70 bg-background/95 backdrop-blur-sm shadow-xl shadow-peach/5 p-8 sm:p-10">
          {children}
        </div>

        <Link
          href="/"
          className="mt-6 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          ← Back to home
        </Link>
      </div>
    </div>
  );
}
