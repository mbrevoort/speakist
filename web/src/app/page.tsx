// Marketing landing page.
//
// Layout: Nav → Hero → PolishedOutput → ValueProps → HowItWorks →
// FinalCTA → Footer.
//
// PolishedOutput sits right after the hero — it's the visceral demo of
// the polish value prop (raw speech → clean text), and lands the
// "better than built-in" pitch before the abstract value-prop cards.
//
// FAQ lives at /faq as its own page (linked from the nav and footer)
// rather than as a section here, to keep the home page focused on
// conversion.

import { Nav } from "@/components/marketing/nav";
import { Hero } from "@/components/marketing/hero";
import { PolishedOutput } from "@/components/marketing/polished-output";
import { ValueProps } from "@/components/marketing/value-props";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { FinalCTA } from "@/components/marketing/cta";
import { Footer } from "@/components/marketing/footer";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <Nav />
      <main className="flex-1">
        <Hero />
        <PolishedOutput />
        <ValueProps />
        <HowItWorks />
        <FinalCTA />
      </main>
      <Footer />
    </div>
  );
}
