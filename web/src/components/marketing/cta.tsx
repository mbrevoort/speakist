// Final CTA strip. Last chance to convert before the footer.

import Link from "next/link";
import { Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { env } from "@/lib/env";

export function FinalCTA() {
  // Server Component — reads the per-env Worker var at SSR time so
  // dev / prod each link to their own TestFlight invite. Schema in
  // env.ts has a default that catches `next dev` runs without the
  // wrangler.toml var loaded.
  const testflightURL = env.server.IOS_TESTFLIGHT_URL;
  return (
    <section className="py-24 sm:py-32">
      <div className="container max-w-4xl text-center">
        <h2 className="text-4xl sm:text-5xl font-semibold tracking-tight">
          Stop typing at the speed of your fingers.
        </h2>
        <p className="mt-5 text-lg text-muted-foreground max-w-2xl mx-auto">
          Sign up, install on Mac or iPhone, start dictating. 3,000 words on
          the house — enough to find out whether you like it before you pay a
          cent.
        </p>
        {/* Primary action gets its own row; install options sit underneath
         *  with behavior-indicating icons (download / external link). */}
        <div className="mt-10 flex justify-center">
          <Button asChild size="xl">
            <Link href="/auth/signin?intent=signup">Start with 3,000 free words</Link>
          </Button>
        </div>
        <div className="mt-4 flex flex-wrap justify-center gap-3">
          <Button asChild size="lg" variant="outline">
            <a href="/api/download/mac" download className="gap-2">
              <Download className="size-4" aria-hidden />
              Download for Mac
            </a>
          </Button>
          <Button asChild size="lg" variant="outline">
            <a
              href={testflightURL}
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
          <Link href="#pricing" className="hover:text-foreground underline-offset-4 hover:underline">
            See pricing details
          </Link>
        </p>
      </div>
    </section>
  );
}
