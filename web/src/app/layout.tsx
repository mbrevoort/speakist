import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

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

export const metadata: Metadata = {
  title: "Speakist — push-to-talk dictation for macOS",
  description:
    "Hold a key, speak, release. Clean text appears at your cursor in any app. Usage-based pricing. Your voice never leaves your device except to be transcribed.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://speakist-dev.brevoortstudio.com"),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>{children}</body>
    </html>
  );
}
