// Mac-app release registry helpers.
//
// Single source of truth: the `releases` table in D1. Everything else —
// appcast XML, download redirects, future super-admin UI — reads from here.
//
// Lifecycle:
//   1. release.sh builds DMG + signs with Sparkle
//   2. release.sh uploads DMG to R2
//   3. release.sh POSTs to /api/admin/releases/publish (bearer-authed) →
//      publishRelease() inserts a row here
//   4. Sparkle clients poll /appcast*.xml → buildAppcastXml() renders from here
//   5. Browser hits /api/download/mac → getLatestRelease() looks up the
//      newest non-yanked row for the requested channel

import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { releases, type NewRelease, type Release, type ReleaseChannel } from "@/lib/db/schema";

// --- Reads ----------------------------------------------------------------

/** Newest non-yanked release for a channel, or null if the channel is empty. */
export async function getLatestRelease(channel: ReleaseChannel): Promise<Release | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(releases)
    .where(and(eq(releases.channel, channel), isNull(releases.yankedAt)))
    .orderBy(desc(releases.publishedAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Full history for a channel (newest first). Used by appcast rendering and
 *  by the super-admin UI (future). */
export async function listReleases(channel: ReleaseChannel): Promise<Release[]> {
  const db = getDb();
  return db
    .select()
    .from(releases)
    .where(eq(releases.channel, channel))
    .orderBy(desc(releases.publishedAt));
}

// --- Writes ---------------------------------------------------------------

/**
 * Insert a new release. Called by the /api/admin/releases/publish endpoint
 * after the release script uploads the DMG to R2. Idempotent on
 * (channel, version, build_number) — if a row already exists we return it
 * instead of failing, so a retry of a partially-failed release is safe.
 */
export async function publishRelease(input: Omit<NewRelease, "id" | "publishedAt" | "yankedAt" | "yankedReason">): Promise<Release> {
  const db = getDb();

  // Dedupe check.
  const existing = await db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.channel, input.channel),
        eq(releases.version, input.version),
        eq(releases.buildNumber, input.buildNumber)
      )
    )
    .limit(1);
  if (existing[0]) return existing[0];

  const id = crypto.randomUUID();
  await db.insert(releases).values({
    id,
    channel: input.channel,
    version: input.version,
    buildNumber: input.buildNumber,
    dmgUrl: input.dmgUrl,
    dmgSizeBytes: input.dmgSizeBytes,
    sparkleSignature: input.sparkleSignature,
    minimumSystemVersion: input.minimumSystemVersion ?? "14.0",
    releaseNotes: input.releaseNotes ?? null,
    publishedBy: input.publishedBy ?? null,
  });

  const [row] = await db.select().from(releases).where(eq(releases.id, id)).limit(1);
  return row!;
}

/** Mark a release as yanked (emergency rollback). Row stays for audit. */
export async function yankRelease(id: string, reason: string): Promise<void> {
  const db = getDb();
  await db
    .update(releases)
    .set({ yankedAt: new Date(), yankedReason: reason })
    .where(eq(releases.id, id));
}

// --- Appcast XML rendering ------------------------------------------------

/**
 * Build a Sparkle appcast XML document for `channel`. Renders every non-
 * yanked row, newest first.
 *
 * The `sparkleSignature` column may contain either the bare EdDSA base64
 * value or the full `sparkle:edSignature="..." length="..."` fragment as
 * emitted by `sign_update` — we normalize to the bare signature so the
 * enclosure tag's `length=` attribute is always sourced from D1's
 * `dmgSizeBytes` column. That avoids duplicate-attribute XML (which
 * Sparkle rejects with "An error occurred while parsing the update feed")
 * regardless of what the release script stored.
 */
export async function buildAppcastXml(channel: ReleaseChannel, feedUrl: string, feedTitle: string): Promise<string> {
  const rows = await listReleases(channel);
  const live = rows.filter((r) => !r.yankedAt);

  const items = live.map((r) => {
    const pubDate = r.publishedAt.toUTCString();
    const notes = r.releaseNotes
      ? `      <description><![CDATA[${r.releaseNotes}]]></description>\n`
      : "";
    const edSignature = extractEdSignature(r.sparkleSignature);
    return `    <item>
      <title>Version ${escapeXml(r.version)}</title>
      <pubDate>${pubDate}</pubDate>
      <sparkle:version>${r.buildNumber}</sparkle:version>
      <sparkle:shortVersionString>${escapeXml(r.version)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>${escapeXml(r.minimumSystemVersion)}</sparkle:minimumSystemVersion>
${notes}      <enclosure
        url="${escapeXml(r.dmgUrl)}"
        sparkle:edSignature="${escapeXml(edSignature)}"
        length="${r.dmgSizeBytes}"
        type="application/octet-stream" />
    </item>`;
  });

  return `<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"
     xmlns:dc="http://purl.org/dc/elements/1.1/"
     version="2.0">
  <channel>
    <title>${escapeXml(feedTitle)}</title>
    <link>${escapeXml(feedUrl)}</link>
    <description>${escapeXml(feedTitle)} — update feed</description>
    <language>en</language>
${items.join("\n")}
  </channel>
</rss>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Pull the bare EdDSA base64 signature out of a `sparkleSignature` column
 * value. Accepts either:
 *   - the full `sign_update` output: `sparkle:edSignature="abc==" length="123"`
 *   - just the base64 value: `abc==`
 * Trailing `==` padding and `+`/`/` / `-`/`_` alphabets are all preserved.
 */
function extractEdSignature(stored: string): string {
  const m = stored.match(/sparkle:edSignature\s*=\s*"([^"]+)"/);
  if (m) return m[1];
  return stored.trim();
}
