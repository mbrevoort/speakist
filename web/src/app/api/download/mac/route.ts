// GET /api/download/mac
//
// Resolves the latest Speakist DMG from the configured GitHub repo and 302's
// the user to it. Keeps speakist.ai/api/download/mac stable even when the
// underlying version changes, so the landing page / dashboard CTA links
// don't need updating per release.
//
// We cache GitHub's response for 15 minutes via Cloudflare's edge cache to
// avoid hammering the GitHub API (the unauthenticated limit is 60/hour/IP;
// a Worker effectively shares one IP across callers). If the API call fails
// entirely we fall back to the GitHub releases page.
//
// Config: set GITHUB_REPO as a Worker secret:
//   pnpm exec wrangler secret put GITHUB_REPO --env dev
//   value: brevoortstudio/speakist (or wherever you host releases)

const CACHE_TTL_SECONDS = 15 * 60;

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
  html_url: string;
}

export async function GET(): Promise<Response> {
  const repo = process.env.GITHUB_REPO;
  if (!repo) {
    return new Response(
      "Download isn't configured yet — the GITHUB_REPO secret is missing on this Worker.",
      { status: 503, headers: { "content-type": "text/plain" } }
    );
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        "user-agent": "speakist-worker",
        accept: "application/vnd.github+json",
      },
      // Cloudflare-specific hint to cache this response at the edge.
      cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
    } as RequestInit);

    if (res.status === 404) {
      return new Response("No releases have been published yet.", {
        status: 404,
        headers: { "content-type": "text/plain" },
      });
    }
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);

    const release = (await res.json()) as GitHubRelease;
    const dmg = release.assets.find((a) => a.name.toLowerCase().endsWith(".dmg"));

    // Asset present → direct DMG. Otherwise fall back to the release page.
    return Response.redirect(dmg?.browser_download_url ?? release.html_url, 302);
  } catch (err) {
    console.error("[download/mac] GitHub API fetch failed:", err);
    return Response.redirect(`https://github.com/${repo}/releases/latest`, 302);
  }
}
