// Top navigation. Sticky, with a translucent cream blur to float over the
// hero. Simple set of links — on mobile we collapse to just the wordmark +
// primary CTA (no hamburger menu in v1; not enough links to justify it).
//
// Server component — reads session via getAuth() so signed-in users see
// "Go to dashboard" instead of "Sign in / Get started". Keeps the landing
// page coherent for returning users.

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/brand/logo";
import { getAuth } from "@/lib/auth";

export async function Nav() {
  const { auth } = await getAuth();
  const session = await auth();
  const signedIn = !!session?.user?.id;

  return (
    <header className="sticky top-0 z-40 w-full backdrop-blur supports-[backdrop-filter]:bg-background/70 border-b border-border/50">
      <div className="container flex h-16 max-w-6xl items-center justify-between">
        <Link href="/" aria-label="Speakist home">
          <Wordmark />
        </Link>

        <nav className="hidden md:flex items-center gap-1 text-sm text-muted-foreground">
          <Link href="/#how" className="px-3 py-2 hover:text-foreground transition-colors">
            How it works
          </Link>
          <Link href="/#pricing" className="px-3 py-2 hover:text-foreground transition-colors">
            Pricing
          </Link>
          <Link href="/faq" className="px-3 py-2 hover:text-foreground transition-colors">
            FAQ
          </Link>
        </nav>

        <div className="flex items-center gap-2">
          {signedIn ? (
            <Button asChild size="sm">
              <Link href="/dashboard">Go to dashboard →</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
                <Link href="/auth/signin">Sign in</Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/auth/signin">Get started</Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
