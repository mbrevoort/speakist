// Speakist data model — Drizzle schema for D1 (SQLite).
//
// Conventions:
//   * All IDs are `text` UUIDs generated via crypto.randomUUID() at row-create
//     time (Workers runtime has crypto.randomUUID built in).
//   * All timestamps are `integer` Unix *milliseconds* (SQLite has no native
//     date type; ms gives us subsecond precision without the pitfalls of
//     ISO-string sorting).
//   * Money is stored as `integer` BIGINT millicents — 1/1000 of a cent. $5 =
//     500_000. SQLite INTEGER is 64-bit; JavaScript Number is safe up to
//     2^53, which covers >$90 quintillion in millicents.
//   * Booleans are `integer` 0/1 via Drizzle's `mode: "boolean"`.
//   * Enums are `text` with a TypeScript union type hint (Drizzle's way on
//     SQLite). Runtime enforcement happens in our zod schemas + app code.
//
// Authorization: SQLite has no RLS. Every query goes through a repository
// helper in src/lib/authz.ts that enforces ownership/membership rules. Do not
// touch `db` directly from route handlers — only via the authz wrappers.

import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ---- column helpers -------------------------------------------------------

/** Unix milliseconds; SQLite INTEGER is 64-bit so year-9999 fits comfortably. */
const timestampMs = (name: string) => integer(name, { mode: "timestamp_ms" });

/** 0/1 integer with a TS boolean view. */
const bool = (name: string) => integer(name, { mode: "boolean" });

/** Generate a UUID using the Workers-native Web Crypto. */
const uuid = () => crypto.randomUUID();

// ---- Auth.js tables (adapter-required) ------------------------------------
//
// Shape must match @auth/drizzle-adapter expectations. We use plural
// snake_case names via the first arg (adapter is config-driven so this works)
// and add our app fields (display_name, is_super_admin) to `users`.

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(uuid),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestampMs("email_verified"),
  image: text("image"),

  // Speakist extensions:
  displayName: text("display_name"),
  isSuperAdmin: bool("is_super_admin").notNull().default(false),
  // Post-transcription polish pass. When enabled, /api/transcribe runs
  // the transcript through llama-3.1-8b-instant on Groq with the system
  // prompt below (or a server-baked default when null). Stored on the
  // user so every signed-in Mac inherits the same behavior. Originally
  // shipped as "cleanup"; renamed in migration 0007.
  polishEnabled: bool("polish_enabled").notNull().default(false),
  polishSystemPrompt: text("polish_system_prompt"),
  // Polish aggressiveness. `intuitive` runs the intent-aware prompt
  // (applies explicit self-corrections, fixes obvious slips). `prescriptive`
  // is conservative — only punctuation, capitalization, and clear
  // grammar fixes, never touches meaning. Default is `prescriptive`
  // (the safer mode); the migration that adds this column promotes
  // existing polish-enabled users to `intuitive` to preserve their
  // current behavior.
  polishMode: text("polish_mode", { enum: ["intuitive", "prescriptive"] })
    .notNull()
    .default("prescriptive"),
  // One-shot per-user gate on the signup bonus. Stamped the first time
  // the user gets an org provisioned (whether by `provisionNewUser` on
  // first sign-in or by the dashboard "create your own workspace" CTA
  // after leaving a previous org). Once non-null, no future org
  // creation by this user grants the bonus again — preventing a
  // leave-and-recreate loop from minting credit endlessly.
  signupBonusGrantedAt: timestampMs("signup_bonus_granted_at"),
  createdAt: timestampMs("created_at").notNull().$defaultFn(() => new Date()),
  updatedAt: timestampMs("updated_at").notNull().$defaultFn(() => new Date()),
});

export const accounts = sqliteTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.providerAccountId] }),
  })
);

export const sessions = sqliteTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestampMs("expires").notNull(),
});

export const verificationTokens = sqliteTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestampMs("expires").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.identifier, t.token] }),
  })
);

// ---- Organizations + membership + invitations -----------------------------

export type OrgRole = "owner" | "admin" | "member";

export const organizations = sqliteTable(
  "organizations",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),

    // When true, usage_events don't debit credit_ledger. Paired with an
    // override key so comped orgs point at their own Deepgram project.
    isComped: bool("is_comped").notNull().default(false),

    // Encrypted at the app layer — never read without going through
    // src/lib/crypto.ts (added in Phase 5). Nullable ⇒ use system key.
    deepgramKeyOverrideEncrypted: text("deepgram_key_override_encrypted"),
    // Parallel Groq key override (added Phase B+). Same encrypt pattern;
    // when set, this org's Groq transcriptions bill against their Groq
    // project, not ours. Our credit ledger still debits retail.
    groqKeyOverrideEncrypted: text("groq_key_override_encrypted"),

    // JSON array of "provider/model" slugs this org's users are allowed
    // to dispatch. NULL ⇒ no restriction (every active provider_pricing
    // row is usable). /api/transcribe enforces this with a 403.
    allowedModelsJson: text("allowed_models_json"),

    // e.g. "acme.com" — anyone signing up with this email domain is auto-
    // joined as a 'member' at signup time.
    autoJoinDomain: text("auto_join_domain"),

    stripeCustomerId: text("stripe_customer_id"),

    // Billing (Phase 4). Auto-top-up triggers when the balance drops below
    // threshold during a debit. Null threshold/amount means "use defaults
    // from pricing_config". `stripeDefaultPaymentMethodId` is populated the
    // first time a Checkout top-up completes with setup_future_usage on,
    // and is required for off-session auto-top-up charges.
    //
    // `autoTopupMaxMonthlyMillicents` is the hard ceiling on how much we
    // can auto-charge in a calendar month. NULL ⇒ no cap (the org's only
    // safety is the threshold/amount config). Provides bounded downside
    // for users who'd otherwise be uncomfortable enabling auto-top-up at
    // all — see docs/pricing-strategy.md.
    autoTopupEnabled: bool("auto_topup_enabled").notNull().default(false),
    autoTopupThresholdMillicents: integer("auto_topup_threshold_millicents"),
    autoTopupAmountMillicents: integer("auto_topup_amount_millicents"),
    autoTopupMaxMonthlyMillicents: integer("auto_topup_max_monthly_millicents"),
    stripeDefaultPaymentMethodId: text("stripe_default_payment_method_id"),

    createdAt: timestampMs("created_at").notNull().$defaultFn(() => new Date()),
    updatedAt: timestampMs("updated_at").notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    autoJoinIdx: index("organizations_auto_join_idx").on(t.autoJoinDomain),
  })
);

export const orgMembers = sqliteTable(
  "org_members",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<OrgRole>().notNull().default("member"),
    createdAt: timestampMs("created_at").notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
    // Enforced one-org-per-user invariant. Migration 0015 added the
    // matching UNIQUE INDEX at the SQL layer; reflecting it here keeps
    // Drizzle introspection in sync.
    userUnique: uniqueIndex("org_members_user_unique").on(t.userId),
  })
);

export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").$type<OrgRole>().notNull().default("member"),
    token: text("token").notNull().unique(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => users.id),
    expiresAt: timestampMs("expires_at").notNull(),
    acceptedAt: timestampMs("accepted_at"),
    createdAt: timestampMs("created_at").notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    orgIdx: index("invitations_org_idx").on(t.orgId),
    emailIdx: index("invitations_email_idx").on(t.email),
  })
);

// ---- Vocabulary (per-user, synced from Mac app) ---------------------------
// Server is source of truth. Mac pulls on launch, pushes on every correction
// save. `updatedAt` is the LWW marker. Soft delete via `deletedAt` so the Mac
// can reconcile tombstones instead of silently re-creating removed rows.

export const vocabularyEntries = sqliteTable(
  "vocabulary_entries",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fromText: text("from_text").notNull(),
    toText: text("to_text").notNull(),
    count: integer("count").notNull().default(1),
    isProperNoun: bool("is_proper_noun").notNull().default(false),
    lastSeen: timestampMs("last_seen").notNull().$defaultFn(() => new Date()),
    createdAt: timestampMs("created_at").notNull().$defaultFn(() => new Date()),
    updatedAt: timestampMs("updated_at").notNull().$defaultFn(() => new Date()),
    deletedAt: timestampMs("deleted_at"),
  },
  (t) => ({
    userUpdatedIdx: index("vocab_user_updated_idx").on(t.userId, t.updatedAt),
    unique: uniqueIndex("vocab_unique").on(t.userId, t.fromText, t.toText),
  })
);

// ---- Credit ledger --------------------------------------------------------
// Append-only. Balance = SUM(delta_millicents) for an org. Stripe idempotency
// is handled via the unique stripe_event_id. Usage spends link back to a
// usage_events row via usage_event_id.

export type CreditReason =
  | "signup_bonus"
  | "stripe_topup"
  | "stripe_auto_topup"
  | "usage"
  | "refund"
  | "adjustment"
  | "comp";

export const creditLedger = sqliteTable(
  "credit_ledger",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deltaMillicents: integer("delta_millicents").notNull(),
    reason: text("reason").$type<CreditReason>().notNull(),
    stripeEventId: text("stripe_event_id").unique(),
    usageEventId: text("usage_event_id"),
    createdBy: text("created_by").references(() => users.id),
    note: text("note"),
    createdAt: timestampMs("created_at").notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    orgIdx: index("credit_ledger_org_idx").on(t.orgId, t.createdAt),
  })
);

// ---- Usage events ---------------------------------------------------------
// One row per transcription. Deduped per org via (org_id, transcription_client_id)
// — the client UUID from the Mac app. Also stores `upstream_cost_millicents`
// (what we paid the provider) alongside `cost_millicents` (what we charged
// the org) so super-admin can compute margin.

export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    transcriptionClientId: text("transcription_client_id").notNull(),
    // Which provider produced this transcription. 'deepgram' | 'groq' |
    // 'openai' | 'xai'. Phase A ships with only 'deepgram' live; defaulted
    // on the ALTER so legacy rows backfill cleanly.
    providerId: text("provider_id").notNull().default("deepgram"),
    wordCount: integer("word_count").notNull(),
    // Store ms (integer) rather than real seconds so we don't introduce a
    // second floating-point column. `audio_ms / 1000` in app code when
    // displaying.
    audioMs: integer("audio_ms"),
    model: text("model").notNull(),
    costMillicents: integer("cost_millicents").notNull().default(0),
    // Renamed from `deepgram_cost_millicents` in migration 0004. The old
    // column is still present in the DB for one release as a safety hatch;
    // Phase D drops it. Drizzle schema only maps the new name.
    upstreamCostMillicents: integer("upstream_cost_millicents"),
    // 1 when /api/transcribe ran the LLM polish pass and used the polished
    // output, 0 otherwise. Added in migration 0007 so the usage dashboard
    // can show which transcriptions went through polish.
    polishApplied: bool("polish_applied").notNull().default(false),
    // Wall-clock ms the Worker spent handling this transcription (STT
    // upstream + polish + DB writes). NULL for events inserted before
    // migration 0008. Surfaced in the dashboard's recent-events table.
    processingMs: integer("processing_ms"),
    createdAt: timestampMs("created_at").notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    orgIdx: index("usage_events_org_idx").on(t.orgId, t.createdAt),
    userIdx: index("usage_events_user_idx").on(t.userId, t.createdAt),
    unique: uniqueIndex("usage_events_unique").on(t.orgId, t.transcriptionClientId),
  })
);

// ---- Provider pricing -----------------------------------------------------
// Per-(provider, model) rates. Supersedes `pricing_config.price_per_word_millicents`
// for transcription billing starting in Phase A (which remains for any
// legacy callers until Phase D cleanup).
//
// `cost_per_minute_millicents` is what the provider charges us; stored as
// REAL because providers price in fractions of a cent (Groq turbo is
// ~0.667 mC/min) and we don't want to lose precision before applying the
// retail markup. `retail_per_minute_millicents` is the charge to the org.

export const providerPricing = sqliteTable(
  "provider_pricing",
  {
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    costPerMinuteMillicents: real("cost_per_minute_millicents").notNull(),
    retailPerMinuteMillicents: real("retail_per_minute_millicents").notNull(),
    active: bool("active").notNull().default(true),
    updatedAt: timestampMs("updated_at").notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.providerId, t.model] }),
  })
);

// ---- Pricing config (singleton) -------------------------------------------
// Editable only by super admin. Per-word price is `real` (float) because it's
// a small constant we multiply word counts by — precision loss is immaterial
// since we round to integer millicents on the final charge.

export const pricingConfig = sqliteTable("pricing_config", {
  id: integer("id").primaryKey().default(1),
  // Display-and-debit per-word rate. 20 mc/word = $0.20 per 1,000 words —
  // the headline rate behind the SKU ladder in src/lib/billing/topupTiers.ts.
  // Positions Speakist at half the effective price of Wispr Flow at typical
  // use (30K words/mo). Also used to convert balance millicents → "words
  // remaining" for user-facing display (see millicentsToWords in src/lib/utils.ts).
  pricePerWordMillicents: real("price_per_word_millicents").notNull().default(20.0),
  deepgramPerMinuteMillicents: real("deepgram_per_minute_millicents").notNull().default(430.0),
  // Free trial allowance, once on first org provisioning. 60,000 mc =
  // $0.60 = ~3,000 words at the headline rate. See docs/pricing-strategy.md
  // for why 3K (one-time, no recurring grant).
  signupBonusMillicents: integer("signup_bonus_millicents").notNull().default(60_000),
  // Auto-top-up defaults. Threshold = balance below which a charge fires.
  // Amount = how much we charge. 100_000 mc = $1.00 = ~5,000 words remaining.
  // 500_000 mc = $5.00 = the smallest top-up tier (no bonus on auto-topup).
  defaultAutoTopupAmountMillicents: integer("default_auto_topup_amount_millicents").notNull().default(500_000),
  defaultAutoTopupThresholdMillicents: integer("default_auto_topup_threshold_millicents").notNull().default(100_000),
  // Default monthly cap (max auto-topup spend per calendar month). Used to
  // pre-fill the per-org cap when an admin enables it for the first time.
  defaultAutoTopupMaxMonthlyMillicents: integer("default_auto_topup_max_monthly_millicents").notNull().default(2_000_000),
  updatedAt: timestampMs("updated_at").notNull().$defaultFn(() => new Date()),
});

// ---- App settings (singleton) ---------------------------------------------

export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey().default(1),
  systemDeepgramKeyEncrypted: text("system_deepgram_key_encrypted"),
  // System-wide Groq API key, encrypted at rest with APP_ENCRYPTION_KEY.
  // Used as the default for any org without its own groq_key_override.
  // Configured via the super admin /admin/system page. Default routing
  // is now Groq-first (English → Whisper Turbo, else → Whisper Large)
  // so this key is actually load-bearing — without it the transcribe
  // path 500s for every org that hasn't set its own override.
  systemGroqKeyEncrypted: text("system_groq_key_encrypted"),
  // Super-admin overrides for the two polish-mode system prompts.
  // NULL → use the baked-in default in `lib/transcription/polish.ts`.
  // Edited only at /admin/system; end users never see the prompt text.
  polishIntuitivePrompt: text("polish_intuitive_prompt"),
  polishPrescriptivePrompt: text("polish_prescriptive_prompt"),
  // When false, provisionNewUser stops auto-creating a workspace for
  // brand-new signups that don't match an existing org's auto_join_domain.
  // Used to lock down dev/staging to invite-only access. Production stays
  // at true (the default) — random signups are the business model.
  allowPublicOrgCreation: bool("allow_public_org_creation").notNull().default(true),
  // Optional Slack incoming-webhook destinations, configured at
  // /admin/system. Each has an encrypted URL and an enable flag —
  // disabling preserves the URL so an admin can flip it back on
  // without re-pasting. URLs are AES-GCM encrypted with
  // APP_ENCRYPTION_KEY (same envelope as the system provider keys).
  // See lib/slack.ts for posting.
  slackNewUserWebhookUrlEncrypted: text("slack_new_user_webhook_url_encrypted"),
  slackNewUserWebhookEnabled: bool("slack_new_user_webhook_enabled").notNull().default(false),
  slackTopupWebhookUrlEncrypted: text("slack_topup_webhook_url_encrypted"),
  slackTopupWebhookEnabled: bool("slack_topup_webhook_enabled").notNull().default(false),
  updatedAt: timestampMs("updated_at").notNull().$defaultFn(() => new Date()),
});

// ---- Mac sign-in (device-code flow) ---------------------------------------
// Mac app POSTs to request a pair (user_code, device_code). It displays the
// user_code to the user and polls /api/auth/device/poll with device_code.
// When the user visits /link, signs in, and enters user_code, we stamp
// user_id. The next poll trades device_code for a refresh-token-backed
// session.

export const deviceAuthCodes = sqliteTable(
  "device_auth_codes",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    userCode: text("user_code").notNull().unique(),
    deviceCode: text("device_code").notNull().unique(),
    userId: text("user_id").references(() => users.id),
    approvedAt: timestampMs("approved_at"),
    consumedAt: timestampMs("consumed_at"),
    expiresAt: timestampMs("expires_at").notNull(),
    deviceName: text("device_name"),
    createdAt: timestampMs("created_at").notNull().$defaultFn(() => new Date()),
  }
);

export const macSessions = sqliteTable(
  "mac_sessions",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // We never store the raw token; only its SHA-256 hex.
    refreshTokenHash: text("refresh_token_hash").notNull().unique(),
    deviceName: text("device_name"),
    lastUsedAt: timestampMs("last_used_at"),
    revokedAt: timestampMs("revoked_at"),
    createdAt: timestampMs("created_at").notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    userIdx: index("mac_sessions_user_idx").on(t.userId),
  })
);

// ---- Releases (Mac-app update registry) -----------------------------------
// One row per published DMG. Serves both:
//   1. /appcast.xml (+ -beta, -dev) which Sparkle polls
//   2. /api/download/mac — the "latest" pointer for fresh installs
// Release script inserts rows via POST /api/admin/releases/publish.

export type ReleaseChannel = "stable" | "beta" | "dev";

export const releases = sqliteTable(
  "releases",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    channel: text("channel").$type<ReleaseChannel>().notNull(),
    version: text("version").notNull(),
    buildNumber: integer("build_number").notNull(),
    dmgUrl: text("dmg_url").notNull(),
    dmgSizeBytes: integer("dmg_size_bytes").notNull(),
    sparkleSignature: text("sparkle_signature").notNull(),
    minimumSystemVersion: text("minimum_system_version").notNull().default("14.0"),
    releaseNotes: text("release_notes"),
    publishedAt: timestampMs("published_at").notNull().$defaultFn(() => new Date()),
    publishedBy: text("published_by").references(() => users.id),
    yankedAt: timestampMs("yanked_at"),
    yankedReason: text("yanked_reason"),
  },
  (t) => ({
    channelIdx: index("releases_channel_published_idx").on(t.channel, t.publishedAt),
    channelVersionBuildUnique: uniqueIndex("releases_channel_version_build_unique")
      .on(t.channel, t.version, t.buildNumber),
  })
);

// ---- Type exports for the rest of the app ---------------------------------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Organization = typeof organizations.$inferSelect;
export type OrgMember = typeof orgMembers.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type VocabularyEntry = typeof vocabularyEntries.$inferSelect;
export type CreditLedgerRow = typeof creditLedger.$inferSelect;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type PricingConfig = typeof pricingConfig.$inferSelect;
export type AppSettings = typeof appSettings.$inferSelect;
export type DeviceAuthCode = typeof deviceAuthCodes.$inferSelect;
export type MacSession = typeof macSessions.$inferSelect;
export type Release = typeof releases.$inferSelect;
export type NewRelease = typeof releases.$inferInsert;
