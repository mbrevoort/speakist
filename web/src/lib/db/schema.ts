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

    // e.g. "acme.com" — anyone signing up with this email domain is auto-
    // joined as a 'member' at signup time.
    autoJoinDomain: text("auto_join_domain"),

    stripeCustomerId: text("stripe_customer_id"),

    // Billing (Phase 4). Auto-top-up triggers when the balance drops below
    // threshold during a debit. Null threshold/amount means "use defaults
    // from pricing_config". `stripeDefaultPaymentMethodId` is populated the
    // first time a Checkout top-up completes with setup_future_usage on,
    // and is required for off-session auto-top-up charges.
    autoTopupEnabled: bool("auto_topup_enabled").notNull().default(false),
    autoTopupThresholdMillicents: integer("auto_topup_threshold_millicents"),
    autoTopupAmountMillicents: integer("auto_topup_amount_millicents"),
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
    userIdx: index("org_members_user_idx").on(t.userId),
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
  pricePerWordMillicents: real("price_per_word_millicents").notNull().default(5.74),
  deepgramPerMinuteMillicents: real("deepgram_per_minute_millicents").notNull().default(430.0),
  signupBonusMillicents: integer("signup_bonus_millicents").notNull().default(500_000),
  defaultAutoTopupAmountMillicents: integer("default_auto_topup_amount_millicents").notNull().default(2_000_000),
  defaultAutoTopupThresholdMillicents: integer("default_auto_topup_threshold_millicents").notNull().default(500_000),
  updatedAt: timestampMs("updated_at").notNull().$defaultFn(() => new Date()),
});

// ---- App settings (singleton) ---------------------------------------------

export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey().default(1),
  systemDeepgramKeyEncrypted: text("system_deepgram_key_encrypted"),
  // When false, provisionNewUser stops auto-creating a workspace for
  // brand-new signups that don't match an existing org's auto_join_domain.
  // Used to lock down dev/staging to invite-only access. Production stays
  // at true (the default) — random signups are the business model.
  allowPublicOrgCreation: bool("allow_public_org_creation").notNull().default(true),
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
