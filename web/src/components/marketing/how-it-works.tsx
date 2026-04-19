// Three-step visual: Hold → Speak → Release. Designed to read at a glance;
// you can understand Speakist's whole UX in 5 seconds from this strip.

export function HowItWorks() {
  return (
    <section id="how" className="py-20 sm:py-28">
      <div className="container max-w-6xl">
        <div className="max-w-2xl mb-16">
          <p className="text-sm uppercase tracking-[0.2em] text-peach-deep font-medium">
            How it works
          </p>
          <h2 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight">
            Three motions. No UI to learn.
          </h2>
        </div>

        <ol className="grid md:grid-cols-3 gap-6 lg:gap-8">
          <Step
            number="01"
            title="Hold."
            body="Put your cursor where you want the text. Hold ⌃⌘X (or any shortcut you pick)."
            visual={<HoldVisual />}
          />
          <Step
            number="02"
            title="Speak."
            body="Say what you want to write. Speakist transcribes as fast as you release the key."
            visual={<SpeakVisual />}
          />
          <Step
            number="03"
            title="Release."
            body="Text lands at your cursor. No window, no confirmation step, no cleanup. Keep typing."
            visual={<ReleaseVisual />}
          />
        </ol>
      </div>
    </section>
  );
}

function Step({
  number,
  title,
  body,
  visual,
}: {
  number: string;
  title: string;
  body: string;
  visual: React.ReactNode;
}) {
  return (
    <li className="group flex flex-col">
      <div className="rounded-2xl bg-white/70 border border-border/70 p-6 flex items-center justify-center h-48">
        {visual}
      </div>
      <div className="mt-6 flex items-baseline gap-3">
        <span className="text-sm font-mono font-semibold text-peach-deep">
          {number}
        </span>
        <h3 className="text-xl font-semibold tracking-tight">{title}</h3>
      </div>
      <p className="mt-2 text-muted-foreground leading-relaxed">{body}</p>
    </li>
  );
}

// --- Step visuals ---

function HoldVisual() {
  return (
    <div className="flex items-end gap-2">
      <MiniKey>⌃</MiniKey>
      <MiniKey>⌘</MiniKey>
      <MiniKey active>X</MiniKey>
    </div>
  );
}

function SpeakVisual() {
  // Five bars of varying heights — the live waveform shape.
  const heights = [28, 56, 88, 56, 28];
  return (
    <div className="flex items-center gap-2" aria-label="Waveform">
      {heights.map((h, i) => (
        <span
          key={i}
          className="w-3 rounded-full bg-peach"
          style={{
            height: `${h}px`,
            animation: `wave 1.2s ease-in-out ${i * 0.12}s infinite`,
          }}
        />
      ))}
      <style>{`
        @keyframes wave {
          0%, 100% { transform: scaleY(0.6); }
          50% { transform: scaleY(1.0); }
        }
      `}</style>
    </div>
  );
}

function ReleaseVisual() {
  // Simulated text cursor with a completed sentence.
  return (
    <div className="flex items-center gap-1 text-sm font-mono text-foreground">
      <span>Let me double-check that number.</span>
      <span className="inline-block w-[2px] h-4 bg-peach animate-pulse" />
    </div>
  );
}

function MiniKey({ children, active = false }: { children: React.ReactNode; active?: boolean }) {
  return (
    <div
      className={
        "inline-flex h-12 w-12 items-center justify-center rounded-xl border text-xl font-medium " +
        (active
          ? "bg-peach text-white border-peach-deep shadow-md shadow-peach/40 animate-pulse"
          : "bg-white text-plum border-border")
      }
    >
      {children}
    </div>
  );
}
