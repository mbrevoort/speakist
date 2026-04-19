// Final CTA strip. Last chance to convert before the footer.

import Link from "next/link";
import { Button } from "@/components/ui/button";

export function FinalCTA() {
  return (
    <section className="py-24 sm:py-32">
      <div className="container max-w-4xl text-center">
        <h2 className="text-4xl sm:text-5xl font-semibold tracking-tight">
          Stop typing at the speed of your fingers.
        </h2>
        <p className="mt-5 text-lg text-muted-foreground max-w-2xl mx-auto">
          Sign up, download the Mac app, start dictating. We give you $5 of
          credit to get comfortable before you pay a cent.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-4">
          <Button asChild size="xl">
            <Link href="/auth/signin">Start with $5 free</Link>
          </Button>
          <Button asChild size="xl" variant="outline">
            <Link href="#pricing">See pricing details</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
