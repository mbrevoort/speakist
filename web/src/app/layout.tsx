import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

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
