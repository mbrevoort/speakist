// Public /link page — where Mac users land after their Mac app shows them
// a user_code. Three states:
//   1. Not signed in → redirect to /auth/signin with callback back here
//   2. Signed in, no code submitted yet → form (code may be pre-filled via ?code=)
//   3. Submitted → success or error, rendered via the client component

import Link from "next/link";
import { redirect } from "next/navigation";
import { LinkIcon } from "lucide-react";
import { Wordmark } from "@/components/brand/logo";
import { getAuth } from "@/lib/auth";
import { LinkClient } from "./link-client";

export const metadata = { title: "Link your Mac — Speakist" };

export default async function LinkPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { auth } = await getAuth();
  const session = await auth();
  const { code } = await searchParams;

  if (!session?.user) {
    const target = code ? `/link?code=${encodeURIComponent(code)}` : "/link";
    redirect(`/auth/signin?callbackUrl=${encodeURIComponent(target)}`);
  }

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center px-4 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] opacity-50 blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse at top, rgba(255, 138, 101, 0.25), transparent 70%)",
        }}
      />

      <Link href="/" aria-label="Speakist home" className="relative mb-8">
        <Wordmark markClassName="w-8 h-8" className="text-xl" />
      </Link>

      <div className="relative w-full max-w-md rounded-2xl border border-border/70 bg-background/95 backdrop-blur-sm shadow-xl shadow-peach/5 p-8 sm:p-10">
        <div className="mx-auto inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-peach/15 text-peach-deep mb-5">
          <LinkIcon className="size-6" />
        </div>
        <h1 className="text-center text-2xl font-semibold tracking-tight">
          Link your Mac
        </h1>
        <p className="mt-2 text-center text-sm text-muted-foreground">
          Type the code your Mac is showing to connect this account.
        </p>

        <LinkClient defaultCode={code ?? ""} userEmail={session.user.email ?? ""} />
      </div>

      <Link
        href="/dashboard"
        className="mt-6 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        ← Back to dashboard
      </Link>
    </div>
  );
}
