// "Check your email" page — shown after submitting the sign-in form.
// Auth.js redirects here automatically when `pages.verifyRequest` is set.
//
// If the visitor is already signed in (e.g. they clicked the magic link in
// one tab while this tab was still open), the "check your email" copy would
// be misleading — redirect them to the dashboard instead.

import Link from "next/link";
import { redirect } from "next/navigation";
import { MailCheck } from "lucide-react";
import { getAuth } from "@/lib/auth";

export const metadata = {
  title: "Check your email — Speakist",
};

export default async function VerifyRequestPage() {
  const { auth } = await getAuth();
  const session = await auth();
  if (session?.user) {
    redirect("/dashboard");
  }
  return (
    <div className="text-center">
      <div className="mx-auto inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-peach/10 text-peach-deep">
        <MailCheck className="size-6" />
      </div>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight">
        Check your email.
      </h1>
      <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
        We just sent a sign-in link to the email address you entered. Click
        the link to continue. The link expires in 24 hours.
      </p>

      <div className="mt-8 rounded-xl bg-muted/50 p-4 text-xs text-muted-foreground text-left">
        <p className="font-semibold text-foreground mb-1">Not in your inbox?</p>
        <ul className="space-y-1">
          <li>• Check your spam or promotions folder.</li>
          <li>• Make sure you typed the address correctly.</li>
          <li>
            • Still nothing?{" "}
            <Link
              href="/auth/signin"
              className="text-peach-deep underline underline-offset-2 hover:text-foreground"
            >
              Try again
            </Link>
            .
          </li>
        </ul>
      </div>
    </div>
  );
}
