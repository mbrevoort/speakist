// Four-up grid of differentiators. These are the reasons Speakist exists
// instead of Wispr Flow / Superwhisper / Aqua. Keep the copy short — one
// headline + one sentence per card.

import { CircleDollarSign, Gauge, Lock, Sparkles } from "lucide-react";

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
            Other dictation apps bolt on features until their pricing page
            looks like a SaaS dashboard. Speakist only does one thing, and
            charges you accordingly.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card
            icon={<CircleDollarSign className="size-5" />}
            title="Pay for what you transcribe."
            body="No monthly subscription. A penny buys you about 170 words. Most people spend under $1 a month."
          />
          <Card
            icon={<Gauge className="size-5" />}
            title="Usage-based, not per-seat."
            body="Bring your whole team for free. You only pay for the audio that actually gets transcribed."
          />
          <Card
            icon={<Sparkles className="size-5" />}
            title="One shortcut. That&apos;s it."
            body="Hold ⌃⌘X, speak, release. No overlays, no AI chat window, no &ldquo;smart prompts.&rdquo; Just text at your cursor."
          />
          <Card
            icon={<Lock className="size-5" />}
            title="Your voice stays on your Mac."
            body="Audio is sent to our backend, transcribed, and the result is returned. Neither the audio nor the transcript is ever saved to disk in the cloud — only on your device."
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
