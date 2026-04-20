// GET /appcast-beta.xml — Sparkle update feed for the BETA channel.
// See /appcast.xml for the general story; same mechanism.

import { buildAppcastXml } from "@/lib/releases";

export async function GET(): Promise<Response> {
  const xml = await buildAppcastXml(
    "beta",
    "https://speakist.ai/appcast-beta.xml",
    "Speakist (beta)"
  );
  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}
