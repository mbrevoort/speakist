// GET /api/download/mac[?channel=stable|beta|dev]
//
// The "download the Mac app" redirect. Looks up the newest non-yanked
// release for the requested channel in D1 and 302s to its DMG URL on R2.
// Default channel is `stable` — matches what the landing-page download
// button should point at for anonymous visitors.
//
// No external API calls (we pulled artifact hosting off GitHub onto R2),
// so no rate-limit surface. Purely a D1 lookup.
//
// Responses:
//   302 → DMG URL on success
//   404 → no release has been published to that channel yet
//   400 → invalid channel param

import { getLatestRelease } from "@/lib/releases";
import type { ReleaseChannel } from "@/lib/db/schema";

const VALID_CHANNELS: readonly ReleaseChannel[] = ["stable", "beta", "dev"] as const;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rawChannel = (url.searchParams.get("channel") ?? "stable").toLowerCase();

  if (!VALID_CHANNELS.includes(rawChannel as ReleaseChannel)) {
    return new Response(
      `Unknown channel '${rawChannel}'. Use one of: ${VALID_CHANNELS.join(", ")}.`,
      { status: 400, headers: { "content-type": "text/plain" } }
    );
  }

  const release = await getLatestRelease(rawChannel as ReleaseChannel);
  if (!release) {
    return new Response(
      `No releases have been published to the '${rawChannel}' channel yet. Check back soon.`,
      { status: 404, headers: { "content-type": "text/plain" } }
    );
  }

  return Response.redirect(release.dmgUrl, 302);
}
