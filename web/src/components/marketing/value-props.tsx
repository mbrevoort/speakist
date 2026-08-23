// Four-up grid of differentiators. Keep the copy short — one headline +
// one sentence per card. The four cards address the four objections a
// visitor brings: "I already have built-in dictation" / "subscription
// tools are pricey" / "all these tools are bloated with AI chat features"
// / "I don't want my voice in someone's data lake."
//
// The privacy card carries the open-source CTA — it's the natural
// place to convert "trust us" into "verify us" by linking the GitHub
// repo. Don't pull the OSS angle into its own card or a separate
// section; it lives or dies on whether the privacy promise feels
// enforceable, and that's a privacy-card concern.

import { Github, Lock, Sparkles, WifiOff, Zap } from "lucide-react";

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
            Speakist does one thing well: private, fast dictation on your Mac,
            with cloud transcription still available when you need it.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card
            icon={<Zap className="size-5" />}
            title="Better than built-in."
            body="Apple&rsquo;s dictation hasn&rsquo;t gotten meaningfully better in years — hit-or-miss accuracy, awkward punctuation, no polish. Speakist runs multi-stage state-of-the-art models, so the text reads like you meant it."
          />
          <Card
            icon={<WifiOff className="size-5" />}
            title="Works offline."
            body="The models download during setup. After that, local transcription and cleanup need no connection and have no per-word limit."
          />
          <Card
            icon={<Sparkles className="size-5" />}
            title="One gesture. Any app."
            body="Hold ⌃⌘X anywhere on your Mac, speak, then release. No AI chat window and no prompt-writing workflow."
          />
          <Card
            icon={<Lock className="size-5" />}
            title="Your voice stays on your device."
            body="In local mode, dictation audio and transcript text never leave your Mac. The optional cloud engine is clearly labeled and remains opt-in."
            footer={
              <a
                href="https://github.com/mbrevoort/speakist"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-peach-deep hover:underline underline-offset-4"
              >
                <Github className="size-4" />
                Verify it — read the source
              </a>
            }
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
  footer,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  footer?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-background p-6 hover:shadow-md hover:border-peach/40 transition-all flex flex-col">
      <div className="inline-flex items-center justify-center h-9 w-9 rounded-xl bg-peach/10 text-peach-deep">
        {icon}
      </div>
      <h3 className="mt-5 font-semibold text-base">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{body}</p>
      {footer && <div className="mt-4">{footer}</div>}
    </div>
  );
}
