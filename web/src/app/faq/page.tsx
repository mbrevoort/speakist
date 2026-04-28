// FAQ page. Static content; no D1 reads. Linked from the marketing nav
// and footer.
//
// Questions are rendered open — this is a dedicated page, so there's no
// reason to hide answers behind an accordion. A reader who navigated
// here wants to read.
//
// Question set focuses on what visitors plausibly wonder about that the
// landing-page sections don't cleanly answer (offline support, languages,
// app compatibility, word counting, what happens at zero balance, iOS
// keyboard privacy, other platforms, refunds). Avoid restating the value
// props that already live on the home page.

import { Nav } from "@/components/marketing/nav";
import { Footer } from "@/components/marketing/footer";

export const metadata = { title: "FAQ — Speakist" };

interface QA {
  q: string;
  a: React.ReactNode;
}

const QUESTIONS: QA[] = [
  {
    q: "Does Speakist work offline?",
    a: (
      <>
        No. Transcription and polish run on our servers, so you need an
        internet connection. The trade-off is that the app stays small
        (under 30&nbsp;MB) and we can use larger, more accurate models than
        anything that would run on a laptop battery. Latency is typically
        well under a second on a normal connection.
      </>
    ),
  },
  {
    q: "Which languages does Speakist support?",
    a: (
      <>
        English is the default and gets our fastest model. Speakist also
        transcribes most major languages — French, Spanish, German,
        Portuguese, Italian, Dutch, Japanese, and dozens more — and we
        route to the right model automatically. The polish step is
        currently tuned for English; in other languages you still get
        accurate transcription, but punctuation and filler cleanup may be
        lighter.
      </>
    ),
  },
  {
    q: "Will it work in the apps I use?",
    a: (
      <>
        Almost certainly. Speakist types text wherever your cursor
        is — Slack, Notion, Mail, Messages, browser inputs, terminal, code
        editors, even password fields if you really want. There&apos;s no
        per-app integration to install; if the app accepts typing, it
        accepts Speakist.
      </>
    ),
  },
  {
    q: "How is a “word” counted?",
    a: (
      <>
        One word in the <em>final</em> transcript equals one word billed.
        Filler (&ldquo;um,&rdquo; &ldquo;uh&rdquo;), false starts, and
        repetitions that the polish step removes don&apos;t count — you
        only pay for the text that lands at your cursor. You can see your
        word count per dictation in the dashboard.
      </>
    ),
  },
  {
    q: "What happens when I run out of words?",
    a: (
      <>
        Two options. If you turn on auto top-up, Speakist will refill your
        balance automatically when it falls below the threshold you set,
        up to a monthly cap you also control — so you never get a surprise
        bill. If auto top-up is off and your balance hits zero, dictation
        simply pauses until you top up manually. Either way, nothing
        runs without your consent.
      </>
    ),
  },
  {
    q: "Why hold-to-talk instead of a toggle?",
    a: (
      <>
        Holding a key means you never accidentally start recording, and
        you never forget to stop. There&apos;s no &ldquo;am I being
        listened to?&rdquo; mode to track. It&apos;s the same reason
        walkie-talkies and intercoms have worked the way they have for a
        century — your hand is the indicator.
      </>
    ),
  },
  {
    q: "Does the iPhone keyboard see anything else I type?",
    a: (
      <>
        No. The Speakist keyboard is a dedicated dictation surface — it
        has a push-to-talk button and that&apos;s it. There&apos;s no
        traditional QWERTY layout in the keyboard, so there&apos;s
        nothing to log even in principle. You switch to the Speakist
        keyboard when you want to dictate, then switch back to your usual
        keyboard for ordinary typing.
      </>
    ),
  },
  {
    q: "What about Windows, Linux, or Android?",
    a: (
      <>
        Mac and iPhone for now. We&apos;re focused on making that
        experience really good. If you&apos;d like to vote for another
        platform, email{" "}
        <a
          href="mailto:hello@brevoortstudio.com"
          className="text-peach-deep hover:underline underline-offset-4"
        >
          hello@brevoortstudio.com
        </a>{" "}
        — we read everything.
      </>
    ),
  },
  {
    q: "Can I get a refund?",
    a: (
      <>
        Credit purchases are non-refundable in general, but if you were
        charged in error, hit a long outage, or otherwise feel something
        went wrong, email{" "}
        <a
          href="mailto:hello@brevoortstudio.com"
          className="text-peach-deep hover:underline underline-offset-4"
        >
          hello@brevoortstudio.com
        </a>
        . We review case-by-case and we&apos;d rather you be happy than
        right about a clause.
      </>
    ),
  },
];

export default function FAQPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <Nav />
      <main className="flex-1">
        <article className="container max-w-3xl py-16 sm:py-24">
          <header className="mb-12 border-b border-border/60 pb-8">
            <p className="text-sm uppercase tracking-[0.2em] text-peach-deep font-medium">
              FAQ
            </p>
            <h1 className="mt-3 text-4xl sm:text-5xl font-semibold tracking-tight">
              Questions, answered.
            </h1>
            <p className="mt-4 text-base text-muted-foreground">
              Anything we missed?{" "}
              <a
                href="mailto:hello@brevoortstudio.com"
                className="text-peach-deep hover:underline underline-offset-4"
              >
                Ask us directly
              </a>
              .
            </p>
          </header>

          <div className="divide-y divide-border/60 border-b border-border/60">
            {QUESTIONS.map((qa, i) => (
              <section key={i} className="py-7">
                <h2 className="text-lg sm:text-xl font-semibold tracking-tight text-foreground">
                  {qa.q}
                </h2>
                <p className="mt-3 text-base text-muted-foreground leading-relaxed">
                  {qa.a}
                </p>
              </section>
            ))}
          </div>
        </article>
      </main>
      <Footer />
    </div>
  );
}
