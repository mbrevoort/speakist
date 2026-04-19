// Pricing section. Server component that reads pricingConfig live from D1,
// so whatever super admin sets for `price_per_word_millicents` is what
// visitors see. Also derives a couple of illustrative comparisons (per
// 1,000 words, typical monthly spend) so the per-word figure doesn't feel
// abstract.
//
// Math:
//   * price_per_word_millicents is a REAL. Default 5.74. (5.74 × 10⁻⁵ ¢/word.)
//   * dollars per word = millicents / 100_000
//   * per 1,000 words = that × 1000
//   * "typical" monthly usage = 500 words/day × 30 days = 15,000 words

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
  const pricePerWordMc = cfg?.pricePerWordMillicents ?? 5.74;
  const signupBonusMc = cfg?.signupBonusMillicents ?? 500_000;

  const pricePerWordDollars = pricePerWordMc / 100_000;
  const pricePer1000Words = pricePerWordDollars * 1000;
  const typicalMonthlyWords = 15_000; // 500/day × 30 days
  const typicalMonthlySpend = pricePerWordDollars * typicalMonthlyWords;
  const signupBonusDollars = signupBonusMc / 100_000;

  return (
    <section id="pricing" className="border-y border-border/60 bg-white/40 py-20 sm:py-28">
      <div className="container max-w-6xl">
        <div className="max-w-2xl mx-auto text-center mb-14">
          <p className="text-sm uppercase tracking-[0.2em] text-peach-deep font-medium">
            Pricing
          </p>
          <h2 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight">
            One rate. Priced by the word.
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            We charge a little more than Deepgram charges us, and that&apos;s it.
            No seats, no tiers, no enterprise upsell.
          </p>
        </div>

        <div className="mx-auto max-w-3xl">
          {/* Main pricing card */}
          <div className="relative rounded-3xl border-2 border-peach/30 bg-background p-8 sm:p-10 shadow-lg shadow-peach/5">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2">
              <span className="rounded-full bg-peach text-primary-foreground text-xs font-semibold px-3 py-1">
                ${signupBonusDollars.toFixed(0)} free to start
              </span>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-end gap-4 sm:gap-10 justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Per-word pricing</p>
                <p className="mt-2 flex items-baseline gap-2">
                  <span className="text-5xl sm:text-6xl font-semibold tracking-tight">
                    ${pricePer1000Words.toFixed(2)}
                  </span>
                  <span className="text-lg text-muted-foreground">/ 1,000 words</span>
                </p>
              </div>
              <div className="text-sm text-muted-foreground sm:text-right">
                <p>
                  Typical light use{" "}
                  <span className="font-mono text-foreground">~${typicalMonthlySpend.toFixed(2)}/mo</span>
                </p>
                <p className="text-xs mt-1">
                  500 words/day · 30 days
                </p>
              </div>
            </div>

            <hr className="my-8 border-border/60" />

            <ul className="grid sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
              <PricingRow>${signupBonusDollars.toFixed(0)} in credits on signup — no card required</PricingRow>
              <PricingRow>Unlimited team members, no per-seat fee</PricingRow>
              <PricingRow>Top up $10 or $25 at a time (or auto-top-up)</PricingRow>
              <PricingRow>Custom vocabulary for names and jargon</PricingRow>
              <PricingRow>Your transcripts stay on your Mac</PricingRow>
              <PricingRow>Deepgram Nova-3 STT under the hood</PricingRow>
            </ul>

            <div className="mt-10 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              <Button asChild size="lg" className="flex-1">
                <Link href="/api/auth/signin">
                  Get your ${signupBonusDollars.toFixed(0)} free credit
                </Link>
              </Button>
            </div>
          </div>

          {/* Comparison blurb */}
          <p className="mt-8 text-center text-sm text-muted-foreground max-w-xl mx-auto">
            For context: subscription dictation apps run{" "}
            <span className="font-medium text-foreground">$8&ndash;$15 a month flat</span>.
            Speakist&apos;s typical light user pays{" "}
            <span className="font-mono text-foreground">${typicalMonthlySpend.toFixed(2)}</span>
            {" "}for the same kind of use — and if you stop dictating, your bill goes to zero.
          </p>
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
