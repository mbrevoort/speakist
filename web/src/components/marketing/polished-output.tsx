// Polished output demo. Three pairs of (raw speech) → (polished text) so a
// visitor understands what "polish" actually does in five seconds. Sits
// between Hero and ValueProps as the visceral proof point before the
// abstract differentiator copy.
//
// The examples are intentionally varied: a casual message, a work note,
// an email reply — each demonstrates a different polish behavior (filler
// removal + punctuation, sentence-restart cleanup, natural pause handling).

import { ArrowDown, ArrowRight } from "lucide-react";

interface ExamplePair {
  said: string;
  appears: string;
  /** Short label describing what kind of dictation this is. */
  context: string;
}

const EXAMPLES: ExamplePair[] = [
  {
    context: "Casual message",
    said: "hey um can you send me that report from yesterday i think it had the q3 numbers the one we were talking about with sarah",
    appears: "Hey, can you send me that report from yesterday? I think it had the Q3 numbers — the one we were talking about with Sarah.",
  },
  {
    context: "Work note",
    said: "uh okay so the deploy is going to get pushed to friday because the staging tests aren’t ready yet and i don’t want to like rush it",
    appears: "The deploy is going to get pushed to Friday because the staging tests aren’t ready yet, and I don’t want to rush it.",
  },
  {
    context: "Email reply",
    said: "thanks for sending those over i’ll take a look this afternoon and uh get back to you by end of day with any questions",
    appears: "Thanks for sending those over. I’ll take a look this afternoon and get back to you by end of day with any questions.",
  },
];

export function PolishedOutput() {
  return (
    <section className="py-20 sm:py-24">
      <div className="container max-w-5xl">
        <div className="max-w-2xl mb-12">
          <p className="text-sm uppercase tracking-[0.2em] text-peach-deep font-medium">
            Speech, polished
          </p>
          <h2 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight">
            Talk like you talk. Read like you wrote.
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Speakist cleans up filler, false starts, and punctuation
            automatically. You sound clear — even when you didn&apos;t. The
            polish is optional, tuned to preserve your voice, and runs in
            milliseconds before the text appears at your cursor.
          </p>
        </div>

        <div className="space-y-5">
          {EXAMPLES.map((pair, i) => (
            <Pair key={i} pair={pair} />
          ))}
        </div>
      </div>
    </section>
  );
}

function Pair({ pair }: { pair: ExamplePair }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background overflow-hidden">
      <div className="px-4 py-2 border-b border-border/40 bg-muted/30">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {pair.context}
        </span>
      </div>
      {/* Mobile: stacked with down arrow. Desktop: side-by-side with right
       *  arrow. Same content; the layout adapts to screen size. */}
      <div className="grid sm:grid-cols-[1fr_auto_1fr] gap-0 sm:items-stretch">
        <div className="p-5 sm:p-6">
          <p className="text-xs uppercase tracking-wider font-medium text-muted-foreground mb-2">
            What you said
          </p>
          <p className="text-base text-muted-foreground leading-relaxed font-mono">
            {pair.said}
          </p>
        </div>

        <div className="hidden sm:flex items-center justify-center px-2 text-peach-deep">
          <ArrowRight className="size-5" aria-hidden />
        </div>
        <div className="flex sm:hidden items-center justify-center py-2 text-peach-deep border-y border-border/40 bg-muted/20">
          <ArrowDown className="size-4" aria-hidden />
        </div>

        <div className="p-5 sm:p-6 bg-peach/[0.04]">
          <p className="text-xs uppercase tracking-wider font-medium text-peach-deep mb-2">
            What appears
          </p>
          <p className="text-base text-foreground leading-relaxed">
            {pair.appears}
          </p>
        </div>
      </div>
    </div>
  );
}
