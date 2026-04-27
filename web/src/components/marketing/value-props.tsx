// Four-up grid of differentiators. Keep the copy short — one headline +
// one sentence per card. The four cards address the four objections a
// visitor brings: "I already have built-in dictation" / "subscription
// tools are pricey" / "all these tools are bloated with AI chat features"
// / "I don't want my voice in someone's data lake."

import { CircleDollarSign, Lock, Sparkles, Zap } from "lucide-react";

export function ValueProps() {
  return (
    <section className="border-y border-border/60 bg-white/40 py-20 sm:py-24">
      <div className="container max-w-6xl">
        <div className="max-w-2xl mb-14">
          <p className="text-sm uppercase tracking-[0.2em] text-peach-deep font-medium">
            What&apos;s different
          </p>
          <h2 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight">
            Built for people who want a tool, not a platform.
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Built-in dictation has been a half-finished feature for years.
            Subscription tools charge you whether you use them or not.
            Speakist does one thing — well — and only charges you when you
            actually use it.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card
            icon={<Zap className="size-5" />}
            title="Better than built-in."
            body="Apple&rsquo;s dictation hasn&rsquo;t gotten meaningfully better in years — hit-or-miss accuracy, awkward punctuation, no polish. Speakist runs multi-stage state-of-the-art models, so the text reads like you meant it."
          />
          <Card
            icon={<CircleDollarSign className="size-5" />}
            title="Pay only when you dictate."
            body="No subscription. No per-seat fee. About half the price of Wispr Flow at typical use — and when you&rsquo;re not dictating, your bill is zero."
          />
          <Card
            icon={<Sparkles className="size-5" />}
            title="One gesture. Any app."
            body="Hold ⌃⌘X on Mac. On iPhone, switch to the Speakist keyboard — a dedicated dictation keyboard you install once — and tap-and-hold. No overlays, no AI chat window, no &ldquo;smart prompts.&rdquo;"
          />
          <Card
            icon={<Lock className="size-5" />}
            title="Your voice stays on your device."
            body="Audio is sent to our backend, transcribed, and the result is returned. Neither the audio nor the transcript is ever saved in the cloud — only on your device."
          />
        </div>
      </div>
    </section>
  );
}

function Card({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-background p-6 hover:shadow-md hover:border-peach/40 transition-all">
      <div className="inline-flex items-center justify-center h-9 w-9 rounded-xl bg-peach/10 text-peach-deep">
        {icon}
      </div>
      <h3 className="mt-5 font-semibold text-base">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{body}</p>
    </div>
  );
}
