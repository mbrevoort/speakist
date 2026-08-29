import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

// Force dynamic rendering for every route. Our app reads from D1 via
// getCloudflareContext() across legacy authenticated and admin routes,
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
    "Hold a key, speak, release. Private speech-to-text and language-model cleanup run on your Mac, then clean text appears at your cursor.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>
        {children}
      </body>
    </html>
  );
}
