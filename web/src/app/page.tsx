// Marketing landing page.
//
// Layout: Nav → Hero → ValueProps → HowItWorks → Pricing (RSC, reads D1) →
// FinalCTA → Footer. Pricing is the only block that can't be fully static;
// everything else is pure markup. OpenNext still SSRs the whole page (so
// the pricing query runs on the Worker), but the static sections are
// effectively free.

import { Nav } from "@/components/marketing/nav";
import { Hero } from "@/components/marketing/hero";
import { ValueProps } from "@/components/marketing/value-props";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { Pricing } from "@/components/marketing/pricing";
import { FinalCTA } from "@/components/marketing/cta";
import { Footer } from "@/components/marketing/footer";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <Nav />
      <main className="flex-1">
        <Hero />
        <ValueProps />
        <HowItWorks />
        <Pricing />
        <FinalCTA />
      </main>
      <Footer />
    </div>
  );
}
