// Final CTA strip. Last chance to convert before the footer.

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

export function FinalCTA() {
  return (
    <section className="py-24 sm:py-32">
      <div className="container max-w-4xl text-center">
        <h2 className="text-4xl sm:text-5xl font-semibold tracking-tight">
          Stop typing at the speed of your fingers.
        </h2>
        <p className="mt-5 text-lg text-muted-foreground max-w-2xl mx-auto">
          Install on your Mac and start dictating. Local transcription and
          cleanup are free, unlimited, and account-free.
        </p>
        {/* Primary action gets its own row; install options sit underneath
         *  with behavior-indicating icons (download / external link). */}
        <div className="mt-10 flex justify-center">
          <Button asChild size="xl">
            <a href="/api/download/mac" download className="gap-2">
              <Download className="size-4" aria-hidden />
              Download for Mac
            </a>
          </Button>
        </div>
        <p className="mt-6 text-sm text-muted-foreground">
          <a href="#pricing" className="hover:text-foreground underline-offset-4 hover:underline">
            See pricing details
          </a>
        </p>
      </div>
    </section>
  );
}
