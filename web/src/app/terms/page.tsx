// Terms of Service. Static content; no D1 reads.
//
// IMPORTANT: this content was drafted from a standard template and
// reflects Speakist's actual practices as of the last-updated date below.
// It is NOT a substitute for review by counsel before public launch. If
// you change billing terms (refunds, auto-renewal, etc.), service scope,
// or jurisdiction, update this document.

import { Nav } from "@/components/marketing/nav";
import { Footer } from "@/components/marketing/footer";

export const metadata = { title: "Terms of Service — Speakist" };

const LAST_UPDATED = "April 27, 2026";

export default function TermsPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <Nav />
      <main className="flex-1">
        <article className="container max-w-3xl py-16 sm:py-24">
          <header className="mb-12 border-b border-border/60 pb-8">
            <p className="text-sm uppercase tracking-[0.2em] text-peach-deep font-medium">
              Terms
            </p>
            <h1 className="mt-3 text-4xl sm:text-5xl font-semibold tracking-tight">
              Terms of Service
            </h1>
            <p className="mt-4 text-sm text-muted-foreground">
              Last updated: {LAST_UPDATED}
            </p>
          </header>

          <div className="space-y-10 text-base leading-relaxed text-foreground/90">
            <Section>
              <P>
                These terms govern your use of Speakist, a dictation
                service made by Brevoort Studio LLC
                (&ldquo;Brevoort Studio,&rdquo; &ldquo;we,&rdquo;
                &ldquo;us,&rdquo; &ldquo;our&rdquo;). By using Speakist,
                you agree to these terms. If you don&apos;t agree, please
                don&apos;t use the service.
              </P>
            </Section>

            <Section title="1. The service">
              <P>
                Speakist is a push-to-talk dictation tool for macOS and
                iOS. You hold a shortcut on Mac or use the Speakist
                keyboard on iPhone, speak, and clean text appears at your
                cursor in any app. The service is currently in beta —
                features may change as we develop the product.
              </P>
            </Section>

            <Section title="2. Eligibility">
              <P>
                You must be at least 13 years old to use Speakist (or 16
                in parts of the EU per local law). If you are under the
                legal age of majority in your jurisdiction, you may use
                the service only with the consent of a parent or guardian
                who agrees to these terms on your behalf.
              </P>
            </Section>

            <Section title="3. Your account">
              <P>You need an account to use Speakist. You agree to:</P>
              <UL>
                <LI>Provide accurate information</LI>
                <LI>Keep your credentials secure</LI>
                <LI>
                  Not share your account with others, except as part of an
                  organization you administer
                </LI>
                <LI>
                  Notify us promptly if you suspect unauthorized access
                </LI>
              </UL>
              <P>
                You are responsible for all activity that happens under
                your account.
              </P>
            </Section>

            <Section title="4. Acceptable use">
              <P>You agree not to:</P>
              <UL>
                <LI>
                  Use the service for illegal activities or to violate
                  the rights of others
                </LI>
                <LI>
                  Reverse engineer, decompile, or attempt to extract our
                  source code or models, except where applicable law
                  expressly permits
                </LI>
                <LI>
                  Resell or sublicense the service except as part of an
                  organization plan we authorize
                </LI>
                <LI>
                  Attempt to bypass rate limits, abuse free credits, or
                  otherwise interfere with the service
                </LI>
                <LI>
                  Use the service to create unlawful content, harass
                  others, or harvest data without authorization
                </LI>
              </UL>
              <P>
                We reserve the right to suspend or terminate accounts
                that violate these terms.
              </P>
            </Section>

            <Section title="5. Your content">
              <P>
                The audio you record, the transcripts produced, and any
                vocabulary you add are your content. You retain all
                ownership rights.
              </P>
              <P>
                You grant us a limited, non-exclusive license to process
                your content solely for the purpose of operating the
                service: capturing audio from your device, sending it to
                our transcription provider, returning the transcript to
                your device, and recording the metadata necessary for
                billing. This license does not extend to using your
                content for AI model training, sharing with third parties
                beyond our infrastructure providers, or any purpose
                beyond providing the service to you.
              </P>
              <P>
                We do not store your audio or transcripts on our servers
                beyond the duration of each request. See our{" "}
                <a
                  href="/privacy"
                  className="text-peach-deep hover:underline underline-offset-4"
                >
                  Privacy Policy
                </a>{" "}
                for details.
              </P>
            </Section>

            <Section title="6. Payment, credits, and refunds">
              <P>
                <strong>Pricing.</strong> Speakist is consumption-priced.
                The current per-word rate, top-up tiers, and bonus
                structure are listed on our pricing page. Prices may
                change; we will notify you of changes before they take
                effect for new top-ups.
              </P>
              <P>
                <strong>Credits.</strong> When you top up, you purchase
                credits that are added to your organization&apos;s
                balance and consumed as you use the service. Credits do
                not expire while your account is active.
              </P>
              <P>
                <strong>Refunds.</strong> All credit purchases are{" "}
                <strong>final and non-refundable</strong>, except where
                required by law. If you believe you were charged in
                error, contact us at hello@speakist.ai and we will
                review on a case-by-case basis. We may, in our
                discretion, issue refunds for billing errors, extended
                service outages, or fraud.
              </P>
              <P>
                <strong>Auto top-up.</strong> If you enable auto top-up,
                you authorize us to charge your saved payment method
                when your balance falls below your configured threshold,
                up to the monthly cap you set. You may disable auto
                top-up at any time in your settings.
              </P>
              <P>
                <strong>Failed payments.</strong> If a payment fails, we
                may pause the service until the issue is resolved.
                Negative balances must be cleared before further use.
              </P>
              <P>
                <strong>Taxes.</strong> Prices listed are exclusive of
                taxes. You are responsible for any applicable taxes,
                except those owed on Brevoort Studio&apos;s net income.
              </P>
            </Section>

            <Section title="7. Beta service">
              <P>
                Speakist is currently a beta product. The service is
                provided &ldquo;as is&rdquo; without warranty of any
                kind. Features may change, behave unexpectedly, or be
                temporarily unavailable. Transcription accuracy is not
                guaranteed and may vary based on audio conditions,
                language, and other factors.
              </P>
            </Section>

            <Section title="8. Intellectual property">
              <P>
                Speakist&apos;s software, designs, brand marks, and
                underlying technology are the property of Brevoort
                Studio LLC and our licensors. We grant you a limited,
                personal, non-transferable license to use the service
                per these terms.
              </P>
              <P>You may not:</P>
              <UL>
                <LI>
                  Copy, modify, or distribute the software except as
                  permitted
                </LI>
                <LI>
                  Use Speakist&apos;s trademarks without written
                  permission
                </LI>
                <LI>
                  Remove or alter copyright, trademark, or proprietary
                  notices
                </LI>
              </UL>
            </Section>

            <Section title="9. Privacy">
              <P>
                Your privacy is governed by our{" "}
                <a
                  href="/privacy"
                  className="text-peach-deep hover:underline underline-offset-4"
                >
                  Privacy Policy
                </a>
                . By using Speakist, you also agree to that policy.
              </P>
            </Section>

            <Section title="10. Service availability">
              <P>
                We work to keep Speakist available, but we don&apos;t
                guarantee uptime. The service may be unavailable due to
                maintenance, infrastructure issues, or factors outside
                our control. We are not liable for any losses arising
                from service unavailability.
              </P>
            </Section>

            <Section title="11. Disclaimer of warranties">
              <P>
                To the fullest extent permitted by law, Speakist is
                provided &ldquo;as is&rdquo; and &ldquo;as
                available.&rdquo; We disclaim all warranties, express or
                implied, including warranties of merchantability,
                fitness for a particular purpose, accuracy, and
                non-infringement.
              </P>
              <P>We do not warrant that:</P>
              <UL>
                <LI>The service will meet your requirements</LI>
                <LI>The service will be uninterrupted or error-free</LI>
                <LI>
                  Transcription will be accurate or appropriate for any
                  particular use
                </LI>
                <LI>Defects will be corrected on any timeline</LI>
              </UL>
            </Section>

            <Section title="12. Limitation of liability">
              <P>
                To the fullest extent permitted by law, Brevoort
                Studio&apos;s total liability for any claim arising out
                of these terms or your use of the service is limited to
                the greater of (a) the amount you paid us in the twelve
                months before the claim arose, or (b) one hundred US
                dollars ($100).
              </P>
              <P>
                We are not liable for any indirect, incidental, special,
                consequential, or punitive damages, including lost
                profits, lost data, or business interruption, even if we
                have been advised of the possibility of such damages.
              </P>
              <P>
                Some jurisdictions do not allow limitations on certain
                warranties or liabilities. In those jurisdictions, our
                liability is limited to the maximum extent permitted by
                law.
              </P>
            </Section>

            <Section title="13. Indemnification">
              <P>
                You agree to indemnify and hold Brevoort Studio harmless
                from any claims, damages, or expenses (including
                reasonable attorneys&apos; fees) arising from your use
                of the service in violation of these terms or any law.
              </P>
            </Section>

            <Section title="14. Termination">
              <P>
                You may stop using Speakist at any time. You can delete
                your account from your settings or by contacting us.
              </P>
              <P>
                We may suspend or terminate your access if you violate
                these terms, fail to pay, or for any other reason in our
                reasonable discretion. We will give you notice when
                practical.
              </P>
              <P>On termination:</P>
              <UL>
                <LI>Your access to the service ends</LI>
                <LI>
                  We delete your account information per our Privacy
                  Policy
                </LI>
                <LI>
                  Any remaining credits are forfeited and will not be
                  refunded
                </LI>
              </UL>
            </Section>

            <Section title="15. Changes to these terms">
              <P>
                We may update these terms from time to time. Material
                changes will be communicated by email or via the
                dashboard at least 30 days before they take effect,
                except where immediate changes are required by law.
                Continued use of the service after the effective date of
                new terms constitutes acceptance.
              </P>
            </Section>

            <Section title="16. Governing law and disputes">
              <P>
                These terms are governed by the laws of the State of
                Colorado, USA, without regard to conflict-of-law
                principles. Any dispute arising from these terms will be
                resolved in the state or federal courts located in
                Colorado, and you consent to personal jurisdiction
                there.
              </P>
              <P>
                If you are a consumer in the European Union, you may
                have additional rights under your local consumer
                protection laws.
              </P>
            </Section>

            <Section title="17. Miscellaneous">
              <P>
                If any part of these terms is held unenforceable, the
                rest will remain in effect. Our failure to enforce a
                provision is not a waiver of our right to do so later.
                These terms are the entire agreement between you and
                Brevoort Studio regarding Speakist.
              </P>
            </Section>

            <Section title="18. Contact">
              <P>
                Questions? Email{" "}
                <a
                  href="mailto:hello@speakist.ai"
                  className="text-peach-deep hover:underline underline-offset-4"
                >
                  hello@speakist.ai
                </a>
                .
              </P>
              <P className="text-muted-foreground">
                Brevoort Studio LLC
                <br />
                Colorado, USA
              </P>
            </Section>
          </div>
        </article>
      </main>
      <Footer />
    </div>
  );
}

// --- prose helpers ---------------------------------------------------------

function Section({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      {title && (
        <h2 className="text-2xl font-semibold tracking-tight pt-4">
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

function P({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <p className={className}>{children}</p>;
}

function UL({ children }: { children: React.ReactNode }) {
  return (
    <ul className="list-disc pl-6 space-y-2 marker:text-peach-deep/60">
      {children}
    </ul>
  );
}

function LI({ children }: { children: React.ReactNode }) {
  return <li>{children}</li>;
}
