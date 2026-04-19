// Branded sign-in page.
//
// Single input (email) → server action → magic link emailed → user redirected
// to /auth/verify-request. Auth.js internally still knows the provider as
// "resend"; we call it "Email" in the UI because the user shouldn't need to
// know what Resend is.
//
// The action uses `getAuth()` (not a static `signIn` import) because our
// Auth.js config builds lazily with the D1 binding — see src/lib/auth.ts.

import { Button } from "@/components/ui/button";
import { getAuth } from "@/lib/auth";

export const metadata = {
  title: "Sign in — Speakist",
};

export default function SignInPage() {
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

        <Button type="submit" size="lg" className="w-full">
          Send sign-in link
        </Button>
      </form>

      <p className="mt-6 text-xs text-muted-foreground text-center leading-relaxed">
        New here? Use the same form — we&apos;ll create your account and grant
        your $5 signup credit automatically.
      </p>
    </div>
  );
}
