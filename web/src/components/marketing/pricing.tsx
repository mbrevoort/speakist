// Pricing section. Server component that reads pricingConfig live from D1,
// so whatever super admin sets for `price_per_word_millicents` is what
// visitors see. Also derives a couple of illustrative comparisons (per
// 1,000 words, typical monthly spend) so the per-word figure doesn't feel
// abstract.
//
// Math:
//   * price_per_word_millicents is a REAL. Default 20.0 ($0.20 / 1K words).
//   * dollars per word = millicents / 100_000
//   * per 1,000 words = that × 1000
//   * "typical" monthly usage = 500 words/day × 30 days = 15,000 words
//
// Note: copy here uses dollars deliberately — anonymous landing visitors
// haven't established a balance to anchor in words yet, so the per-1K
// figure is the cleanest way to convey value vs. flat-rate competitors.
// Inside the dashboard we anchor balance in words; this is the boundary.

import Link from "next/link";
import { eq } from "drizzle-orm";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { pricingConfig } from "@/lib/db/schema";

export async function Pricing() {
  const db = getDb();
  const [cfg] = await db
    .select()
    .from(pricingConfig)
    .where(eq(pricingConfig.id, 1))
    .limit(1);

  // Defensive fallback — `pricing_config` is seeded by the init migration,
  // but if we ever wipe the singleton we don't want the landing to crash.
  const pricePerWordMc = cfg?.pricePerWordMillicents ?? 20.0;
  const signupBonusMc = cfg?.signupBonusMillicents ?? 60_000;

  const pricePerWordDollars = pricePerWordMc / 100_000;
  const pricePer1000Words = pricePerWordDollars * 1000;
  const typicalMonthlyWords = 15_000; // 500/day × 30 days
  const typicalMonthlySpend = pricePerWordDollars * typicalMonthlyWords;
  // Free trial expressed in words rather than dollars — that's the unit
  // we want users anchored on (see docs/pricing-strategy.md).
  const signupBonusWords = Math.floor(signupBonusMc / pricePerWordMc);

  return (
    <section id="pricing" className="border-y border-border/60 bg-white/40 py-20 sm:py-28">
      <div className="container max-w-6xl">
        <div className="max-w-2xl mx-auto text-center mb-14">
          <p className="text-sm uppercase tracking-[0.2em] text-peach-deep font-medium">
            Pricing
          </p>
          <h2 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight">
            Local is free. Cloud is optional.
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Use the private on-device stack without an account or word limit.
            Switch to Speakist Cloud when you need multilingual transcription
            or synced account features.
          </p>
        </div>

        <div className="mx-auto grid max-w-5xl gap-6 md:grid-cols-2">
          <div className="relative rounded-3xl border-2 border-peach/30 bg-background p-8 sm:p-10 shadow-lg shadow-peach/5">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2">
              <span className="rounded-full bg-peach text-primary-foreground text-xs font-semibold px-3 py-1">
                Recommended
              </span>
            </div>
            <p className="text-sm text-muted-foreground">On this Mac</p>
            <p className="mt-2 text-5xl sm:text-6xl font-semibold tracking-tight">$0</p>
            <p className="mt-2 text-sm text-muted-foreground">Unlimited local dictation</p>
            <hr className="my-8 border-border/60" />
            <ul className="space-y-3 text-sm">
              <PricingRow>No account or credit card</PricingRow>
              <PricingRow>Parakeet transcription on your Mac</PricingRow>
              <PricingRow>Local AI cleanup with safety fallback</PricingRow>
              <PricingRow>Works offline after first model download</PricingRow>
            </ul>
            <div className="mt-10">
              <Button asChild size="lg" className="flex-1">
                <a href="/api/download/mac" download>Download for Mac</a>
              </Button>
            </div>
          </div>

          <div className="rounded-3xl border border-border bg-background p-8 sm:p-10">
            <p className="text-sm text-muted-foreground">Speakist Cloud</p>
            <p className="mt-2 flex items-baseline gap-2">
              <span className="text-5xl sm:text-6xl font-semibold tracking-tight">
                ${pricePer1000Words.toFixed(2)}
              </span>
              <span className="text-lg text-muted-foreground">/ 1,000 words</span>
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              About ${typicalMonthlySpend.toFixed(2)}/month at 500 words per day
            </p>
            <hr className="my-8 border-border/60" />
            <ul className="space-y-3 text-sm">
              <PricingRow>{signupBonusWords.toLocaleString("en-US")} free words on signup</PricingRow>
              <PricingRow>Multilingual transcription</PricingRow>
              <PricingRow>Synced vocabulary and account features</PricingRow>
              <PricingRow>Pay only for cloud words used</PricingRow>
            </ul>
            <div className="mt-10">
              <Button asChild size="lg" variant="outline" className="w-full">
                <Link href="/auth/signin?intent=signup">Create optional cloud account</Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function PricingRow({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Check className="size-4 text-peach-deep mt-0.5 shrink-0" />
      <span>{children}</span>
    </li>
  );
}
