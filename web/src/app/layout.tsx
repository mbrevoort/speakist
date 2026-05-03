import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { PostHogProvider } from "@/components/posthog-provider";
import { env } from "@/lib/env";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

// Force dynamic rendering for every route. Our app reads from D1 via
// getCloudflareContext() almost everywhere (landing page's Pricing component,
// auth check in middleware-ish layouts, every dashboard / admin page),
// and the sync form of getCloudflareContext can't run at build-time
// prerendering. Marking root-level `dynamic = "force-dynamic"` tells
// Next.js to skip static generation entirely — which matches reality,
// since nothing in this app has meaningful cacheable output across users.
export const dynamic = "force-dynamic";

// metadataBase reads NEXT_PUBLIC_SITE_URL at build time — Next.js
// inlines NEXT_PUBLIC_* into the bundle, so the value comes from
// package.json's deploy:dev / deploy:prod env exports. Local `next
// dev` falls back to localhost. See docs/cicd.md "Config management".
export const metadata: Metadata = {
  title: "Speakist — push-to-talk dictation for macOS",
  description:
    "Hold a key, speak, release. Clean text appears at your cursor in any app. Usage-based pricing. Your voice never leaves your device except to be transcribed.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>
        <PostHogProvider
          apiKey={env.public.NEXT_PUBLIC_POSTHOG_KEY}
          apiHost={env.public.NEXT_PUBLIC_POSTHOG_HOST}
        >
          {children}
        </PostHogProvider>
      </body>
    </html>
  );
}
