// Branded sign-in / sign-up page.
//
// Single magic-link form, but the *copy* is intent-aware via the
// `?intent=signup|signin` query param so a user who just clicked
// "Start with 3,000 free words" from the marketing page lands on
// "Welcome to Speakist" instead of "Welcome back" — and a returning
// user clicking "Sign in" still gets the warm-welcome-back framing.
//
// Why route the same form through three copy variants instead of
// two literal pages: Auth.js's magic-link auth doesn't actually need
// to know whether the user is new or returning — it sends a token
// either way, and our `events.createUser` hook handles first-time
// provisioning. Splitting at the URL layer keeps the implementation
// trivial (one form, one server action) while removing the new-user
// dissonance that "Welcome back" caused for everyone landing here
// from the homepage hero / pricing / final CTA.
//
// Two pieces of query-param plumbing:
//   1. If the visitor is *already* signed in (cookie valid), skip the form
//      entirely and send them where they meant to go — Auth.js's magic-link
//      callback lands back here when callbackUrl=/auth/signin, which would
//      otherwise look like "you're signed out" even though you aren't.
//   2. `?callbackUrl=<path>` is echoed into the form as a hidden input so
//      Auth.js redirects the magic-link click back to the original
//      destination (e.g. /link?code=XXXX for the Mac device flow).

import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getAuth } from "@/lib/auth";

export const metadata = {
  title: "Sign in — Speakist",
};

type Intent = "signup" | "signin" | "default";

interface IntentCopy {
  headline: string;
  subhead: string;
  /** Footnote shown under the form. Empty string ⇒ omitted (used by
   *  the signup variant where the main subhead already covers it). */
  footnote: string;
}

const COPY: Record<Intent, IntentCopy> = {
  signup: {
    headline: "Welcome to Speakist.",
    subhead:
      "Enter your email to claim 3,000 free words. We'll send you a one-time link — no password to remember.",
    footnote: "",
  },
  signin: {
    headline: "Welcome back.",
    subhead: "Enter your email — we'll send you a one-time sign-in link.",
    footnote:
      "First time? Same form — we'll create your account and add 3,000 free words automatically.",
  },
  default: {
    headline: "Sign in or create your account.",
    subhead:
      "Enter your email — we'll send you a one-time link. New here? You'll get 3,000 free words on us.",
    footnote: "",
  },
};

function parseIntent(raw: string | undefined): Intent {
  if (raw === "signup" || raw === "signin") return raw;
  return "default";
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; intent?: string }>;
}) {
  const { callbackUrl, intent: rawIntent } = await searchParams;
  const { auth } = await getAuth();
  const session = await auth();

  // Already signed in → go where they were trying to go.
  if (session?.user) {
    redirect(sanitizeCallback(callbackUrl) ?? "/dashboard");
  }

  const cb = sanitizeCallback(callbackUrl) ?? "/dashboard";
  const intent = parseIntent(rawIntent);
  const copy = COPY[intent];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-center">
        {copy.headline}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground text-center">
        {copy.subhead}
      </p>

      <form
        action={async (formData) => {
          "use server";
          const { signIn } = await getAuth();
          // Auth.js reads `callbackUrl` directly off the FormData and uses it
          // as the redirect destination after the magic-link callback
          // verifies. The hidden input below populates it.
          await signIn("resend", formData);
        }}
        className="mt-8 space-y-4"
      >
        <div>
          <label
            htmlFor="email"
            className="block text-sm font-medium mb-1.5"
          >
            Email address
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            autoFocus
            required
            placeholder="you@example.com"
            className="block w-full rounded-xl border border-input bg-background px-4 py-3 text-sm outline-none transition-all focus:ring-2 focus:ring-ring"
          />
        </div>

        <input type="hidden" name="callbackUrl" value={cb} />
        <input type="hidden" name="redirectTo" value={cb} />

        <Button type="submit" size="lg" className="w-full">
          Email me a link
        </Button>
      </form>

      {copy.footnote && (
        <p className="mt-6 text-xs text-muted-foreground text-center leading-relaxed">
          {copy.footnote}
        </p>
      )}
    </div>
  );
}

/**
 * Only allow same-origin relative paths as callbackUrl. An attacker could
 * otherwise hand us `?callbackUrl=https://evil.com` and we'd redirect after
 * signin. Relative "/..." paths are safe; anything else we reject.
 */
function sanitizeCallback(raw: string | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//")) return null; // protocol-relative
  return raw;
}
