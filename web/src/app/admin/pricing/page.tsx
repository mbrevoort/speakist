// Admin → pricing config editor. Edits the singleton pricing_config row
// that the marketing site + billing page + debitForUsage all read.

import { eq } from "drizzle-orm";
import { PageHeader } from "@/components/dashboard/page-header";
import { requireSuperAdmin } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { pricingConfig } from "@/lib/db/schema";
import { PricingEditor } from "./pricing-client";

export const metadata = { title: "Pricing — Admin" };

export default async function AdminPricingPage() {
  await requireSuperAdmin();
  const db = getDb();
  const [cfg] = await db
    .select()
    .from(pricingConfig)
    .where(eq(pricingConfig.id, 1))
    .limit(1);

  if (!cfg) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Pricing" />
        <p className="text-sm text-destructive">
          pricing_config singleton is missing. Apply migrations or seed the
          row manually.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Pricing"
        description="The single source of truth for retail pricing and signup bonuses. Changes take effect immediately — the landing page and billing math both read this row live."
      />
      <div className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
        <PricingEditor
          pricePerWordMillicents={cfg.pricePerWordMillicents}
          deepgramPerMinuteMillicents={cfg.deepgramPerMinuteMillicents}
          signupBonusDollars={cfg.signupBonusMillicents / 100_000}
          defaultAutoTopupAmountDollars={cfg.defaultAutoTopupAmountMillicents / 100_000}
          defaultAutoTopupThresholdDollars={cfg.defaultAutoTopupThresholdMillicents / 100_000}
        />
      </div>
    </div>
  );
}
