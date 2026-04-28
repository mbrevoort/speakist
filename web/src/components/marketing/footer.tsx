// Footer. Thin on purpose — we don't have enterprise links, social
// proof, or resources yet. Mostly legal + contact placeholders that
// Phases 4 & onwards will wire up to real pages.

import Link from "next/link";
import { Wordmark } from "@/components/brand/logo";

export function Footer() {
  return (
    <footer className="border-t border-border/60 bg-white/30">
      <div className="container max-w-6xl py-12">
        <div className="grid sm:grid-cols-[1fr_auto_auto_auto] gap-8 sm:gap-16">
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
          </div>

          <FooterCol title="Product">
            <FooterLink href="/#how">How it works</FooterLink>
            <FooterLink href="/#pricing">Pricing</FooterLink>
            <FooterLink href="/faq">FAQ</FooterLink>
          </FooterCol>

          <FooterCol title="Account">
            <FooterLink href="/auth/signin">Sign in</FooterLink>
            <FooterLink href="/auth/signin">Get started</FooterLink>
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
