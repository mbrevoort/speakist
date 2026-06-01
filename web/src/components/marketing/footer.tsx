// Footer. Thin on purpose — we don't have enterprise links, social
// proof, or resources yet. Mostly legal + contact placeholders that
// Phases 4 & onwards will wire up to real pages.

import Link from "next/link";
import { Github, Linkedin } from "lucide-react";
import { Wordmark } from "@/components/brand/logo";

/** X / Twitter brand mark. lucide-react ships a "Twitter" icon (the old
 *  bird) and several "X" icons (all close-button glyphs), but no
 *  rebranded X-mark; inline the SVG to match the current X brand. */
function XBrand({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="currentColor"
      className={className}
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117l11.966 15.644Z" />
    </svg>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-border/60 bg-white/30">
      <div className="container max-w-6xl py-12">
        <div className="grid sm:grid-cols-[1fr_auto_auto_auto_auto] gap-8 sm:gap-12">
          <div className="max-w-sm">
            <Wordmark />
            <p className="mt-4 text-sm text-muted-foreground leading-relaxed">
              Push-to-talk dictation for Mac and iPhone. Made in Colorado by{" "}
              <a
                href="https://brevoortstudio.com"
                className="underline underline-offset-4 hover:text-foreground"
              >
                Brevoort Studio
              </a>
              .
            </p>
            <a
              href="https://github.com/mbrevoort/speakist"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-foreground/80 hover:text-foreground"
            >
              <Github className="size-4" />
              Open source on GitHub
            </a>
            <div className="mt-4 flex items-center gap-3">
              <a
                href="https://x.com/speakistai"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Speakist on X"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <XBrand className="size-4" />
              </a>
              <a
                href="https://www.linkedin.com/company/speakist"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Speakist on LinkedIn"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <Linkedin className="size-4" />
              </a>
            </div>
          </div>

          <FooterCol title="Product">
            <FooterLink href="/#how">How it works</FooterLink>
            <FooterLink href="/#pricing">Pricing</FooterLink>
            <FooterLink href="/faq">FAQ</FooterLink>
          </FooterCol>

          <FooterCol title="Account">
            <FooterLink href="/auth/signin?intent=signin">Sign in</FooterLink>
            <FooterLink href="/auth/signin?intent=signup">Get started</FooterLink>
          </FooterCol>

          <FooterCol title="Source">
            <FooterExternalLink href="https://github.com/mbrevoort/speakist">
              GitHub
            </FooterExternalLink>
            <FooterExternalLink href="https://github.com/mbrevoort/speakist/blob/main/LICENSE">
              License
            </FooterExternalLink>
            <FooterExternalLink href="https://github.com/mbrevoort/speakist/blob/main/SECURITY.md">
              Security
            </FooterExternalLink>
          </FooterCol>

          <FooterCol title="Legal">
            <FooterLink href="/privacy">Privacy</FooterLink>
            <FooterLink href="/terms">Terms</FooterLink>
          </FooterCol>
        </div>

        <div className="mt-12 pt-6 border-t border-border/50 flex flex-col sm:flex-row gap-3 justify-between text-xs text-muted-foreground">
          <span>© {new Date().getFullYear()} Brevoort Studio LLC. All rights reserved.</span>
          <span>Made with coffee and ⌃⌘X.</span>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.15em] text-foreground/80 mb-4">
        {title}
      </p>
      <ul className="space-y-2.5">{children}</ul>
    </div>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <li>
      <Link
        href={href}
        className="text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        {children}
      </Link>
    </li>
  );
}

function FooterExternalLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        {children}
      </a>
    </li>
  );
}
