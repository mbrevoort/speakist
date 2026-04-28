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
            Half the price. No subscription.
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Pay only for the words you actually dictate. No monthly commitment,
            no per-seat fees, no auto-renewing tier you forget about.
          </p>
        </div>

        <div className="mx-auto max-w-3xl">
          {/* Main pricing card */}
          <div className="relative rounded-3xl border-2 border-peach/30 bg-background p-8 sm:p-10 shadow-lg shadow-peach/5">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2">
              <span className="rounded-full bg-peach text-primary-foreground text-xs font-semibold px-3 py-1">
                {signupBonusWords.toLocaleString("en-US")} free words to start
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
              <PricingRow>{signupBonusWords.toLocaleString("en-US")} free words on signup — no card required</PricingRow>
              <PricingRow>Volume discounts up to 50% on larger packs</PricingRow>
              <PricingRow>Auto top-up with a monthly cap you control</PricingRow>
              <PricingRow>Works on Mac and iPhone — same account, same balance</PricingRow>
              <PricingRow>Custom vocabulary for names and jargon</PricingRow>
              <PricingRow>Unlimited users per organization</PricingRow>
            </ul>

            <div className="mt-10 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              <Button asChild size="lg" className="flex-1">
                <Link href="/auth/signin?intent=signup">
                  Start with {signupBonusWords.toLocaleString("en-US")} free words
                </Link>
              </Button>
            </div>
          </div>

          {/* Comparison blurb */}
          <p className="mt-8 text-center text-sm text-muted-foreground max-w-xl mx-auto">
            For context: subscription dictation apps run{" "}
            <span className="font-medium text-foreground">$8&ndash;$15 a month flat</span>{" "}
            even if you don&apos;t use them. A Speakist user dictating the same
            500 words/day pays{" "}
            <span className="font-mono text-foreground">~${typicalMonthlySpend.toFixed(2)}/mo</span>
            {" "}— and if you take a week off, your bill takes the week off too.
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
