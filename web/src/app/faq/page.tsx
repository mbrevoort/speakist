// FAQ page. Static content; no D1 reads. Linked from the marketing nav
// and footer.
//
// Questions are rendered open — this is a dedicated page, so there's no
// reason to hide answers behind an accordion. A reader who navigated
// here wants to read.
//
// Question set focuses on what visitors plausibly wonder about that the
// landing-page sections don't cleanly answer (offline support, languages,
// app compatibility, privacy, and other platforms). Avoid restating the value
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
    q: "What Mac does Speakist require?",
    a: (
      <>
        Speakist requires an Apple silicon Mac (M1 or newer) running macOS 14
        or later. The on-device cleanup stack uses Apple&apos;s MLX framework,
        so Intel Macs are not supported by this release.
      </>
    ),
  },
  {
    q: "Does Speakist work offline?",
    a: (
      <>
        Yes. The speech-to-text model and local language model download during
        setup. After that, dictation works without an internet connection.
        Downloading models and checking for app updates require a connection.
      </>
    ),
  },
  {
    q: "Which languages does Speakist support?",
    a: (
      <>
        This release is optimized for English. We are focusing on making the
        on-device English experience excellent before adding more languages.
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
    q: "Is local dictation really unlimited?",
    a: (
      <>
        Yes. Transcription runs on hardware you already own, so there is no
        account, subscription, or per-word charge.
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
    q: "What leaves my Mac?",
    a: (
      <>
        Your dictation audio, transcript text, vocabulary, history, and usage
        data stay on your Mac. The app uses the network only to download model
        files and check for updates.
      </>
    ),
  },
  {
    q: "What about Windows, Linux, or Android?",
    a: (
      <>
        Mac for now. We&apos;re focused on making that
        experience really good. If you&apos;d like to vote for another
        platform, email{" "}
        <a
          href="mailto:hello@speakist.ai"
          className="text-peach-deep hover:underline underline-offset-4"
        >
          hello@speakist.ai
        </a>{" "}
        — we read everything.
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
                href="mailto:hello@speakist.ai"
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
