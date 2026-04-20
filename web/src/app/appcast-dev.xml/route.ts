// GET /appcast-dev.xml — Sparkle update feed for the DEV channel.
// This endpoint is hosted on the dev Worker only (dev-channel builds have
// SUFeedURL=speakist-dev.brevoortstudio.com/appcast-dev.xml baked in).

import { buildAppcastXml } from "@/lib/releases";

export async function GET(): Promise<Response> {
  const xml = await buildAppcastXml(
    "dev",
    "https://speakist-dev.brevoortstudio.com/appcast-dev.xml",
    "Speakist (dev)"
  );
  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}
