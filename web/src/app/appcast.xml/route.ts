// GET /appcast.xml — Sparkle update feed for the STABLE channel.
// Rendered from the `releases` D1 table via buildAppcastXml().
// Sparkle clients poll this URL hourly by default; we cache at the edge
// for 60s so bursts don't hammer D1.

import { buildAppcastXml } from "@/lib/releases";

export async function GET(): Promise<Response> {
  const xml = await buildAppcastXml(
    "stable",
    "https://speakist.ai/appcast.xml",
    "Speakist"
  );
  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}
