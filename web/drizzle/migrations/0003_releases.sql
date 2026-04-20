-- Release registry. One row per Mac-app build that's been published.
--
-- Moves the source of truth for "what's the current version on channel X"
-- from static web/public/appcast*.xml files (previous) + GitHub Releases
-- (previous) to D1. Benefits:
--   * dynamic /appcast.xml endpoints build the feed from this table — no
--     manual editing or git commit per release
--   * /api/download/mac looks up the latest DMG URL here; no GitHub API
--     rate-limit exposure
--   * super-admin can see + yank releases from a UI (Phase 7 polish)
--   * works with a private source repo — DMGs live on R2, not GitHub

CREATE TABLE `releases` (
  `id`                        text PRIMARY KEY NOT NULL,
  -- Channel this release is published on. Matches the Mac app's baked-in
  -- SpeakistChannel Info.plist value.
  `channel`                   text NOT NULL CHECK (channel IN ('stable', 'beta', 'dev')),
  -- Human-facing version string (CFBundleShortVersionString) — e.g. "0.2.0"
  `version`                   text NOT NULL,
  -- Monotonic build number (CFBundleVersion). Sparkle uses this as
  -- `sparkle:version` for ordering.
  `build_number`              integer NOT NULL,
  -- Public URL to the DMG on R2 (e.g. https://downloads.speakist.ai/Speakist-0.2.0.dmg).
  -- Kept as a full URL so we can change hosting arrangements (custom domain,
  -- alternate bucket, fall back to GitHub) without touching the release rows.
  `dmg_url`                   text NOT NULL,
  `dmg_size_bytes`            integer NOT NULL,
  -- Full `sparkle:edSignature="..." length="..."` string emitted by
  -- Sparkle's sign_update — we paste it verbatim into the appcast
  -- <enclosure> when rendering.
  `sparkle_signature`         text NOT NULL,
  -- Minimum macOS. Kept per-row so a future release can bump it without
  -- changing globals.
  `minimum_system_version`    text NOT NULL DEFAULT '14.0',
  -- Optional release notes (plain text or HTML — we wrap in CDATA).
  `release_notes`             text,
  `published_at`              integer NOT NULL,
  `published_by`              text REFERENCES users(id),
  -- Set to mark a release as yanked. A yanked row still exists for audit;
  -- appcast rendering and /api/download/mac skip it.
  `yanked_at`                 integer,
  `yanked_reason`             text
);

-- Appcast rendering wants "all non-yanked rows for this channel, newest
-- first" → this index covers it.
CREATE INDEX `releases_channel_published_idx`
  ON `releases` (`channel`, `published_at` DESC);

-- One release per (channel, version, build_number) combo. Prevents
-- double-publishing the same build to the same channel.
CREATE UNIQUE INDEX `releases_channel_version_build_unique`
  ON `releases` (`channel`, `version`, `build_number`);
