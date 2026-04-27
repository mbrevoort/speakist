// Branded sign-in page.
//
// Single input (email) → server action → magic link emailed → user redirected
// to /auth/verify-request. Auth.js internally still knows the provider as
// "resend"; we call it "Email" in the UI because the user shouldn't need to
// know what Resend is.
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

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const { callbackUrl } = await searchParams;
  const { auth } = await getAuth();
  const session = await auth();

  // Already signed in → go where they were trying to go.
  if (session?.user) {
    redirect(sanitizeCallback(callbackUrl) ?? "/dashboard");
  }

  const cb = sanitizeCallback(callbackUrl) ?? "/dashboard";

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-center">
        Welcome back.
      </h1>
      <p className="mt-2 text-sm text-muted-foreground text-center">
        We&apos;ll email you a one-time sign-in link. No password to remember.
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
          Send sign-in link
        </Button>
      </form>

      <p className="mt-6 text-xs text-muted-foreground text-center leading-relaxed">
        New here? Use the same form — we&apos;ll create your account and add
        3,000 free words to your balance automatically.
      </p>
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
