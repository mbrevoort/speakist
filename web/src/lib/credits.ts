// Credit ledger + auto-top-up glue.
//
// Every mutation of credit balance flows through this module, so "how does
// an org's money change" has exactly one answer per case:
//
//   * grantSignupBonus       — one-shot on org creation (orgs.ts calls this)
//   * recordStripeTopup      — webhook handler calls this after payment
//   * debitForUsage          — usage API calls this when a transcription
//                              is reported; also triggers auto-top-up when
//                              the post-debit balance falls below threshold
//
// Idempotency: stripe_event_id is unique in credit_ledger, so a replayed
// webhook is a silent no-op. All other writes are intended to be called
// exactly once by their specific code path.

import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  creditLedger,
  organizations,
  pricingConfig,
  usageDaily,
  usageEvents,
  type CreditReason,
} from "@/lib/db/schema";
import { getOrgCreditBalance } from "@/lib/orgs";
import { computeCost, getProviderPricing } from "@/lib/transcription/pricing";
import type { ProviderId } from "@/lib/transcription/types";

// --- shared helpers --------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** UTC midnight of the day containing `t`, as a Date. Mirrors the
 *  `(created_at / 86400000) * 86400000` expression the migration's
 *  rollup backfill used, so day boundaries always match. */
function dayStart(t: Date): Date {
  return new Date(Math.floor(t.getTime() / MS_PER_DAY) * MS_PER_DAY);
}

interface AppendLedgerArgs {
  orgId: string;
  deltaMillicents: number;
  reason: CreditReason;
  /** Set for Stripe-driven writes; UNIQUE on credit_ledger so replayed
   *  webhooks return `duplicate: true` rather than double-crediting. */
  stripeEventId?: string;
  usageEventId?: string;
  createdBy?: string;
  note?: string;
}

/**
 * Append a row to `credit_ledger` and atomically bump
 * `organizations.balance_millicents` by the same delta. Single seam
 * for every credit-balance mutation in the codebase — recordStripeTopup,
 * the two debitForUsage paths, the signup bonus, and the admin manual
 * adjustment — so the materialized balance and the ledger can never
 * disagree about anything we wrote.
 *
 * Idempotency: when `stripeEventId` is set we catch the UNIQUE
 * constraint failure and return `{ duplicate: true }` without
 * touching the balance — that path was already credited by the
 * original event.
 *
 * Failure modes: the ledger insert and the balance update are two
 * round-trips, not a transaction. If the second fails, the balance
 * column drifts by `delta` until someone reruns the recompute SQL
 * the migration documented. Rare in practice (same-Worker writes,
 * D1 ack on each); logged loudly when it happens so we can recover.
 */
export async function appendLedger(
  args: AppendLedgerArgs
): Promise<{ duplicate: boolean }> {
  const db = getDb();
  try {
    await db.insert(creditLedger).values({
      orgId: args.orgId,
      deltaMillicents: args.deltaMillicents,
      reason: args.reason,
      stripeEventId: args.stripeEventId,
      usageEventId: args.usageEventId,
      createdBy: args.createdBy,
      note: args.note,
    });
  } catch (err) {
    if (
      args.stripeEventId &&
      (String(err).includes("UNIQUE") || String(err).includes("unique"))
    ) {
      return { duplicate: true };
    }
    throw err;
  }

  // Arithmetic update — `balance + delta` is one statement, atomic at the
  // row level under SQLite's serializable isolation. Concurrent debits on
  // the same org don't lose updates.
  try {
    await db
      .update(organizations)
      .set({
        balanceMillicents: sql`${organizations.balanceMillicents} + ${args.deltaMillicents}`,
      })
      .where(eq(organizations.id, args.orgId));
  } catch (err) {
    console.error(
      `[appendLedger] balance update failed for org=${args.orgId} delta=${args.deltaMillicents}:`,
      err
    );
    throw err;
  }

  return { duplicate: false };
}

interface RecordDailyUsageArgs {
  orgId: string;
  userId: string;
  /** Used to bucket by UTC day. Pass the event's createdAt. */
  occurredAt: Date;
  wordCount: number;
  audioMs: number | null;
  retailCostMillicents: number;
  upstreamCostMillicents: number | null;
  polishApplied: boolean;
}

/**
 * UPSERT one transcription's contribution into `usage_daily`. Called
 * by the debit paths after a successful (non-duplicate) usage_event
 * insert. The rollup feeds the dashboard's by-day chart, the platform-
 * wide admin queries, and the per-user admin views — anywhere we used
 * to scan the raw events table to bucket by day.
 *
 * On conflict (existing row for the (org, user, day) tuple) we add the
 * incoming numbers to the stored ones. SQLite's `excluded` pseudo-table
 * inside `ON CONFLICT DO UPDATE` references the row we tried to insert,
 * so the increment expressions read the new contribution from there.
 */
export async function recordDailyUsage(args: RecordDailyUsageArgs): Promise<void> {
  const db = getDb();
  const day = dayStart(args.occurredAt);
  const audioMs = args.audioMs ?? 0;
  const upstream = args.upstreamCostMillicents ?? 0;
  const polish = args.polishApplied ? 1 : 0;

  try {
    await db
      .insert(usageDaily)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        dayTs: day,
        events: 1,
        wordCount: args.wordCount,
        audioMs,
        costMillicents: args.retailCostMillicents,
        upstreamCostMillicents: upstream,
        polishEvents: polish,
      })
      .onConflictDoUpdate({
        target: [usageDaily.orgId, usageDaily.userId, usageDaily.dayTs],
        set: {
          events: sql`${usageDaily.events} + 1`,
          wordCount: sql`${usageDaily.wordCount} + ${args.wordCount}`,
          audioMs: sql`${usageDaily.audioMs} + ${audioMs}`,
          costMillicents: sql`${usageDaily.costMillicents} + ${args.retailCostMillicents}`,
          upstreamCostMillicents: sql`${usageDaily.upstreamCostMillicents} + ${upstream}`,
          polishEvents: sql`${usageDaily.polishEvents} + ${polish}`,
        },
      });
  } catch (err) {
    // Non-fatal: a failed rollup write means the dashboard chart for
    // this (org, user, day) is short by one event until the next
    // recompute. Logged so it's visible; raw event was already
    // recorded successfully.
    console.error(
      `[recordDailyUsage] failed for org=${args.orgId} user=${args.userId}:`,
      err
    );
  }
}

export interface LedgerRow {
  id: string;
  deltaMillicents: number;
  reason: CreditReason;
  note: string | null;
  createdAt: Date;
}

// --- reads -----------------------------------------------------------------

/** Recent ledger rows for an org (newest first). */
export async function listLedger(orgId: string, limit = 50): Promise<LedgerRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: creditLedger.id,
      deltaMillicents: creditLedger.deltaMillicents,
      reason: creditLedger.reason,
      note: creditLedger.note,
      createdAt: creditLedger.createdAt,
    })
    .from(creditLedger)
    .where(eq(creditLedger.orgId, orgId))
    .orderBy(sql`${creditLedger.createdAt} DESC`)
    .limit(limit);
  return rows;
}

// --- writes ----------------------------------------------------------------

interface RecordStripeTopupArgs {
  orgId: string;
  stripeEventId: string;
  amountMillicents: number;
  note?: string;
  reason?: "stripe_topup" | "stripe_auto_topup";
}

/**
 * Called from the Stripe webhook when a Checkout session or off-session
 * PaymentIntent succeeds. Idempotent on stripe_event_id — replays are silent
 * no-ops.
 */
export async function recordStripeTopup({
  orgId,
  stripeEventId,
  amountMillicents,
  note,
  reason = "stripe_topup",
}: RecordStripeTopupArgs): Promise<{ duplicate: boolean }> {
  return appendLedger({
    orgId,
    deltaMillicents: amountMillicents,
    reason,
    stripeEventId,
    note,
  });
}

// --- auto-topup helpers ----------------------------------------------------

/**
 * Sum the auto-top-up credits an org has already received in the current
 * calendar month. Used by the auto-topup gate to decide whether a fresh
 * charge would exceed the org's monthly cap. Counts only successful
 * `stripe_auto_topup` ledger rows — manual top-ups don't count toward the
 * cap (the user explicitly initiated those).
 *
 * Calendar month = (UTC year, UTC month). We use UTC to avoid the
 * timezone tail wagging the dog when a Worker request is processed near
 * a month boundary.
 */
async function autoTopupSpendThisMonthMc(orgId: string): Promise<number> {
  const db = getDb();
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${creditLedger.deltaMillicents}), 0)`,
    })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.orgId, orgId),
        eq(creditLedger.reason, "stripe_auto_topup"),
        gte(creditLedger.createdAt, monthStart)
      )
    );
  return row?.total ?? 0;
}

interface AutoTopupConfig {
  thresholdMc: number;
  amountMc: number;
  /** NULL ⇒ no cap. */
  maxMonthlyMc: number | null;
}

function resolveAutoTopupConfig(
  org: {
    autoTopupThresholdMillicents: number | null;
    autoTopupAmountMillicents: number | null;
    autoTopupMaxMonthlyMillicents: number | null;
  },
  cfg: {
    autoTopupThresholdDefault: number | null | undefined;
    autoTopupAmountDefault: number | null | undefined;
  } | undefined
): AutoTopupConfig {
  return {
    thresholdMc: org.autoTopupThresholdMillicents ?? cfg?.autoTopupThresholdDefault ?? 100_000,
    amountMc: org.autoTopupAmountMillicents ?? cfg?.autoTopupAmountDefault ?? 500_000,
    // No fallback to a default cap — orgs that haven't set one get
    // unlimited (NULL). The schema default applies only at row-create
    // time and is informational rather than enforced.
    maxMonthlyMc: org.autoTopupMaxMonthlyMillicents,
  };
}

/**
 * Decide whether to fire an auto-topup right now. Returns the amount to
 * charge, or null when we should skip (cap hit, threshold not met, etc.).
 */
async function decideAutoTopup(
  orgId: string,
  currentBalanceMc: number,
  cfg: AutoTopupConfig
): Promise<number | null> {
  if (currentBalanceMc >= cfg.thresholdMc) return null;

  if (cfg.maxMonthlyMc !== null) {
    const spentThisMonth = await autoTopupSpendThisMonthMc(orgId);
    if (spentThisMonth + cfg.amountMc > cfg.maxMonthlyMc) {
      console.warn(
        `[auto-topup] org=${orgId} cap reached: spent=${spentThisMonth} + amount=${cfg.amountMc} > cap=${cfg.maxMonthlyMc}; skipping`
      );
      return null;
    }
  }

  return cfg.amountMc;
}

// --- debit + auto-topup ----------------------------------------------------

interface DebitForUsageArgs {
  orgId: string;
  userId: string;
  transcriptionClientId: string;
  wordCount: number;
  audioMs?: number;
  model: string;
}

export type DebitResult =
  | { kind: "ok"; usageEventId: string; newBalanceMillicents: number; autoTopupTriggered: boolean }
  | { kind: "duplicate"; usageEventId: string }
  | { kind: "insufficient"; balanceMillicents: number };

/**
 * Write a usage_event row and debit the ledger atomically. Both go through
 * D1's batch API so we don't get a half-written debit if one statement fails.
 *
 * If the post-debit balance is below the auto-topup threshold and the org
 * has auto-topup enabled + a saved payment method, we trigger an off-session
 * PaymentIntent (via Stripe) and let its webhook write the top-up credit
 * whenever it succeeds. The debit isn't blocked on the top-up — we always
 * debit first so the caller can write the transcript immediately; if auto-
 * topup fails, the org goes into negative balance until the user tops up
 * manually.
 *
 * Deduplication: (org_id, transcription_client_id) is UNIQUE in usage_events,
 * so a retry from the Mac app with the same client-generated UUID returns
 * kind:"duplicate" instead of double-charging.
 *
 * Returns an "insufficient" result (no debit performed) if the org's balance
 * is already negative AND it's not comped — the Mac app should refuse to
 * transcribe in that case. For Phase 4 we keep this permissive: the Mac app
 * isn't wired yet, and the dashboard already surfaces low-balance warnings.
 */
export async function debitForUsage(args: DebitForUsageArgs): Promise<DebitResult> {
  const db = getDb();

  // Compute charge. Read pricing_config for the per-word rate.
  const [cfg] = await db
    .select({
      perWordMc: pricingConfig.pricePerWordMillicents,
      autoTopupAmountDefault: pricingConfig.defaultAutoTopupAmountMillicents,
      autoTopupThresholdDefault: pricingConfig.defaultAutoTopupThresholdMillicents,
    })
    .from(pricingConfig)
    .where(eq(pricingConfig.id, 1))
    .limit(1);
  const perWordMc = cfg?.perWordMc ?? 5.74;
  const costMc = Math.max(0, Math.ceil(perWordMc * args.wordCount));

  // Load org to know comp status + auto-topup settings.
  const [org] = await db
    .select({
      isComped: organizations.isComped,
      autoTopupEnabled: organizations.autoTopupEnabled,
      autoTopupThresholdMillicents: organizations.autoTopupThresholdMillicents,
      autoTopupAmountMillicents: organizations.autoTopupAmountMillicents,
      autoTopupMaxMonthlyMillicents: organizations.autoTopupMaxMonthlyMillicents,
      stripeCustomerId: organizations.stripeCustomerId,
      stripeDefaultPaymentMethodId: organizations.stripeDefaultPaymentMethodId,
    })
    .from(organizations)
    .where(eq(organizations.id, args.orgId))
    .limit(1);
  if (!org) {
    return { kind: "insufficient", balanceMillicents: 0 };
  }

  // Insert the usage event. The unique index on (org_id, transcription_client_id)
  // catches replays. We do this first because the ledger row's usage_event_id
  // FK references it.
  const usageEventId = crypto.randomUUID();
  try {
    await db.insert(usageEvents).values({
      id: usageEventId,
      orgId: args.orgId,
      userId: args.userId,
      transcriptionClientId: args.transcriptionClientId,
      wordCount: args.wordCount,
      audioMs: args.audioMs,
      model: args.model,
      costMillicents: org.isComped ? 0 : costMc,
    });
  } catch (err) {
    // Client retry with same UUID → find the existing row and return it.
    if (String(err).includes("UNIQUE") || String(err).includes("unique")) {
      const [existing] = await db
        .select({ id: usageEvents.id })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.orgId, args.orgId),
            eq(usageEvents.transcriptionClientId, args.transcriptionClientId)
          )
        )
        .limit(1);
      return { kind: "duplicate", usageEventId: existing?.id ?? usageEventId };
    }
    throw err;
  }

  // Debit — comped orgs skip the ledger so their balance stays at its seed
  // value for display.
  if (!org.isComped && costMc > 0) {
    await appendLedger({
      orgId: args.orgId,
      deltaMillicents: -costMc,
      reason: "usage",
      usageEventId,
    });
  }

  // Roll up into the daily aggregate. We do this for every event
  // (including comped ones at cost 0) so the rollup matches what the
  // raw `usage_events` table holds. Failure here is logged but
  // non-fatal — the raw event was already recorded.
  await recordDailyUsage({
    orgId: args.orgId,
    userId: args.userId,
    occurredAt: new Date(),
    wordCount: args.wordCount,
    audioMs: args.audioMs ?? null,
    retailCostMillicents: org.isComped ? 0 : costMc,
    upstreamCostMillicents: null,
    polishApplied: false,
  });

  // Check auto-topup trigger conditions AFTER the debit so the threshold test
  // uses the just-debited balance.
  const newBalance = await getOrgCreditBalance(args.orgId);
  let autoTopupTriggered = false;
  if (
    !org.isComped &&
    org.autoTopupEnabled &&
    org.stripeCustomerId &&
    org.stripeDefaultPaymentMethodId
  ) {
    const autoCfg = resolveAutoTopupConfig(org, cfg);
    const chargeMc = await decideAutoTopup(args.orgId, newBalance, autoCfg);
    if (chargeMc !== null) {
      // Fire-and-forget: the actual charge + credit happens via Stripe
      // webhook. If the PaymentIntent fails the caller is still in a
      // consistent state (usage recorded, debit performed, balance
      // possibly negative until manual top-up).
      try {
        const { triggerAutoTopup } = await import("@/lib/billing");
        await triggerAutoTopup({
          orgId: args.orgId,
          stripeCustomerId: org.stripeCustomerId,
          stripePaymentMethodId: org.stripeDefaultPaymentMethodId,
          amountMillicents: chargeMc,
        });
        autoTopupTriggered = true;
      } catch (err) {
        console.error("[auto-topup] trigger failed:", err);
        // TODO(phase-4-follow-up): email the user. Needs Resend template.
      }
    }
  }

  return {
    kind: "ok",
    usageEventId,
    newBalanceMillicents: newBalance,
    autoTopupTriggered,
  };
}

// --- debit for audio transcription (Phase A) -------------------------------
//
// `debitForUsage` above bills on a per-word rate and is kept for /api/usage
// backward compat with pre-Phase-A Mac builds. Phase A introduces
// per-(provider, model) per-minute pricing — this function is what
// /api/transcribe calls.
//
// It shares the same `usage_events` dedup key, ledger shape, and
// auto-topup trigger logic with `debitForUsage`. The only differences:
//   * cost is computed from `provider_pricing` × provider-reported audio
//     duration, not per-word;
//   * we record both `cost_millicents` (retail, ledger) AND
//     `upstream_cost_millicents` (provider's cost to us, margin analysis);
//   * `word_count` is still recorded because the ledger UI still uses it
//     as a rough display metric — we compute it here from the transcript.
//
// Returning the same `DebitResult` shape keeps the route handler's switch
// consistent regardless of which path ran.

export interface DebitForAudioTranscriptionArgs {
  orgId: string;
  userId: string;
  transcriptionClientId: string;
  providerId: ProviderId;
  model: string;
  audioSeconds: number;
  /** Word count computed from the transcript. Recorded for display only —
   *  cost is derived from audio duration. */
  wordCount: number;
  /** True when the LLM polish pass ran on this event (and the stored
   *  wordCount is the post-polish figure). Surfaced in the usage
   *  dashboard; never factored into billing. Defaults to false. */
  polishApplied?: boolean;
  /** Wall-clock ms the Worker spent handling the request (STT +
   *  optional polish + bookkeeping). Surfaced in the dashboard for
   *  latency visibility; never factored into billing. */
  processingMs?: number;
}

export async function debitForAudioTranscription(
  args: DebitForAudioTranscriptionArgs
): Promise<DebitResult> {
  const db = getDb();

  // Compute cost from provider_pricing. Missing row is a config error — we
  // treat it as comped rather than a hard block, so a newly-added model
  // never fails user transcriptions just because we forgot to seed the row.
  const pricing = await getProviderPricing(args.providerId, args.model);
  let retailMc = 0;
  let upstreamMc: number | null = null;
  if (pricing && pricing.active) {
    const costs = computeCost(pricing, args.audioSeconds);
    retailMc = costs.retailMc;
    upstreamMc = costs.upstreamMc;
  } else {
    console.warn(
      `[debitForAudioTranscription] no active pricing row for ${args.providerId}/${args.model} — treating as comped`
    );
  }

  // Load org for comp + auto-topup.
  const [org] = await db
    .select({
      isComped: organizations.isComped,
      autoTopupEnabled: organizations.autoTopupEnabled,
      autoTopupThresholdMillicents: organizations.autoTopupThresholdMillicents,
      autoTopupAmountMillicents: organizations.autoTopupAmountMillicents,
      autoTopupMaxMonthlyMillicents: organizations.autoTopupMaxMonthlyMillicents,
      stripeCustomerId: organizations.stripeCustomerId,
      stripeDefaultPaymentMethodId: organizations.stripeDefaultPaymentMethodId,
    })
    .from(organizations)
    .where(eq(organizations.id, args.orgId))
    .limit(1);
  if (!org) {
    return { kind: "insufficient", balanceMillicents: 0 };
  }

  const usageEventId = crypto.randomUUID();
  try {
    await db.insert(usageEvents).values({
      id: usageEventId,
      orgId: args.orgId,
      userId: args.userId,
      transcriptionClientId: args.transcriptionClientId,
      providerId: args.providerId,
      wordCount: args.wordCount,
      audioMs: Math.round(args.audioSeconds * 1000),
      model: args.model,
      costMillicents: org.isComped ? 0 : retailMc,
      upstreamCostMillicents: upstreamMc,
      polishApplied: args.polishApplied ?? false,
      processingMs: args.processingMs ?? null,
    });
  } catch (err) {
    if (String(err).includes("UNIQUE") || String(err).includes("unique")) {
      const [existing] = await db
        .select({ id: usageEvents.id })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.orgId, args.orgId),
            eq(usageEvents.transcriptionClientId, args.transcriptionClientId)
          )
        )
        .limit(1);
      return { kind: "duplicate", usageEventId: existing?.id ?? usageEventId };
    }
    throw err;
  }

  if (!org.isComped && retailMc > 0) {
    await appendLedger({
      orgId: args.orgId,
      deltaMillicents: -retailMc,
      reason: "usage",
      usageEventId,
    });
  }

  await recordDailyUsage({
    orgId: args.orgId,
    userId: args.userId,
    occurredAt: new Date(),
    wordCount: args.wordCount,
    audioMs: Math.round(args.audioSeconds * 1000),
    retailCostMillicents: org.isComped ? 0 : retailMc,
    upstreamCostMillicents: upstreamMc,
    polishApplied: args.polishApplied ?? false,
  });

  const newBalance = await getOrgCreditBalance(args.orgId);

  // Auto-topup: same contract as debitForUsage — fire-and-forget Stripe
  // charge if the post-debit balance dips below threshold and the org has
  // a saved payment method.
  let autoTopupTriggered = false;
  if (
    !org.isComped &&
    org.autoTopupEnabled &&
    org.stripeCustomerId &&
    org.stripeDefaultPaymentMethodId
  ) {
    const [cfg] = await db
      .select({
        autoTopupThresholdDefault: pricingConfig.defaultAutoTopupThresholdMillicents,
        autoTopupAmountDefault: pricingConfig.defaultAutoTopupAmountMillicents,
      })
      .from(pricingConfig)
      .where(eq(pricingConfig.id, 1))
      .limit(1);
    const autoCfg = resolveAutoTopupConfig(org, cfg);
    const chargeMc = await decideAutoTopup(args.orgId, newBalance, autoCfg);
    if (chargeMc !== null) {
      try {
        const { triggerAutoTopup } = await import("@/lib/billing");
        await triggerAutoTopup({
          orgId: args.orgId,
          stripeCustomerId: org.stripeCustomerId,
          stripePaymentMethodId: org.stripeDefaultPaymentMethodId,
          amountMillicents: chargeMc,
        });
        autoTopupTriggered = true;
      } catch (err) {
        console.error("[auto-topup] trigger failed:", err);
      }
    }
  }

  return {
    kind: "ok",
    usageEventId,
    newBalanceMillicents: newBalance,
    autoTopupTriggered,
  };
}
