// Speakist brand marks — speech bubble with waveform, matching the Mac
// app's programmatic icon and design/Speakist.svg.
//
// Two exports:
//   * <LogoMark />     — icon-only, square (for nav, small spaces)
//   * <Wordmark />     — icon + "speakist" wordmark (for hero, footer)
//
// Both are SVG so they scale cleanly and can be tinted via currentColor on
// the bars. The speech bubble uses a peach gradient fixed in the SVG.

import { cn } from "@/lib/utils";

export function LogoMark({ className, ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn("shrink-0", className)}
      {...props}
    >
      <defs>
        <linearGradient id="logo-bubble" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFA98A" />
          <stop offset="1" stopColor="#FF7547" />
        </linearGradient>
      </defs>
      {/* Speech bubble */}
      <path
        d="M14 10 h36 a8 8 0 0 1 8 8 v22 a8 8 0 0 1 -8 8 h-17 l-7 6.5 c-.6.6-1.7.1-1.7-.7 v-5.8 h-10 a8 8 0 0 1 -8 -8 v-22 a8 8 0 0 1 8 -8 z"
        fill="url(#logo-bubble)"
      />
      {/* Waveform bars — white with slight opacity gradient */}
      <g fill="#fff">
        <rect x="18.5" y="25" width="3" height="8"  rx="1.5" opacity="0.85" />
        <rect x="24"   y="22" width="3" height="14" rx="1.5" opacity="0.90" />
        <rect x="29.5" y="19" width="3" height="20" rx="1.5" opacity="1.0"  />
        <rect x="35"   y="22" width="3" height="14" rx="1.5" opacity="0.90" />
        <rect x="40.5" y="25" width="3" height="8"  rx="1.5" opacity="0.85" />
      </g>
    </svg>
  );
}

export function Wordmark({ className, markClassName, ...props }: React.HTMLAttributes<HTMLDivElement> & { markClassName?: string }) {
  return (
    <div
      className={cn("inline-flex items-center gap-2 select-none", className)}
      {...props}
    >
      <LogoMark className={cn("w-7 h-7", markClassName)} />
      <span className="text-xl font-semibold tracking-tight text-foreground">
        speakist
      </span>
    </div>
  );
}
