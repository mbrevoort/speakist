// Auth error page.
//
// Auth.js redirects here with `?error=<code>` for failures:
//   Configuration    — server misconfigured (missing AUTH_SECRET, etc.)
//   AccessDenied     — callback returned false / auth refused
//   Verification     — magic-link token expired or already used
//   Default          — catch-all
//
// We map each code to friendly copy. The query param comes in via searchParams
// (App Router server-component signature).

import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata = {
  title: "Sign-in error — Speakist",
};

const ERROR_COPY: Record<string, { title: string; body: string }> = {
  Configuration: {
    title: "Something's off on our side.",
    body: "We couldn't complete sign-in because of a server configuration issue. Try again in a moment — if it keeps happening, let us know.",
  },
  AccessDenied: {
    title: "Access denied.",
    body: "We couldn't sign you in with that account. If this seems wrong, contact support.",
  },
  Verification: {
    title: "That link didn't work.",
    body: "Sign-in links expire after 24 hours and can only be used once. Request a new one and you'll be on your way.",
  },
  Default: {
    title: "Something went wrong.",
    body: "We couldn't complete sign-in. Please try again.",
  },
};

export default async function ErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const copy = ERROR_COPY[error ?? "Default"] ?? ERROR_COPY.Default;

  return (
    <div className="text-center">
      <div className="mx-auto inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-destructive/10 text-destructive">
        <AlertCircle className="size-6" />
      </div>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight">
        {copy.title}
      </h1>
      <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
        {copy.body}
      </p>

      <div className="mt-8">
        <Button asChild size="lg" className="w-full">
          <Link href="/auth/signin">Try signing in again</Link>
        </Button>
      </div>

      {error && (
        <p className="mt-6 text-xs font-mono text-muted-foreground">
          code: {error}
        </p>
      )}
    </div>
  );
}
