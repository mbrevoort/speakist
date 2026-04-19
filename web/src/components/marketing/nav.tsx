// Top navigation. Sticky, with a translucent cream blur to float over the
// hero. Simple set of links — on mobile we collapse to just the wordmark +
// primary CTA (no hamburger menu in v1; not enough links to justify it).

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/brand/logo";

export function Nav() {
  return (
    <header className="sticky top-0 z-40 w-full backdrop-blur supports-[backdrop-filter]:bg-background/70 border-b border-border/50">
      <div className="container flex h-16 max-w-6xl items-center justify-between">
        <Link href="/" aria-label="Speakist home">
          <Wordmark />
        </Link>

        <nav className="hidden md:flex items-center gap-1 text-sm text-muted-foreground">
          <Link href="#how" className="px-3 py-2 hover:text-foreground transition-colors">
            How it works
          </Link>
          <Link href="#pricing" className="px-3 py-2 hover:text-foreground transition-colors">
            Pricing
          </Link>
          <Link href="#faq" className="px-3 py-2 hover:text-foreground transition-colors">
            FAQ
          </Link>
        </nav>

        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link href="/api/auth/signin">Sign in</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/api/auth/signin">Get started</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
