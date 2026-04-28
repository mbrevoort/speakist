import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { setupTestDb, type TestDbHandle } from "@/test/db";
import { makeOrg, makeUser } from "@/test/factories";
import { getDb } from "@/lib/db";
import {
  appendLedger,
  recordDailyUsage,
  recordStripeTopup,
} from "@/lib/credits";
import { getOrgCreditBalance } from "@/lib/orgs";
import {
  creditLedger,
  organizations,
  usageDaily,
} from "@/lib/db/schema";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dayStart(t: Date): Date {
  return new Date(Math.floor(t.getTime() / MS_PER_DAY) * MS_PER_DAY);
}

describe("appendLedger + materialized balance", () => {
  let h: TestDbHandle;
  beforeEach(() => {
    h = setupTestDb();
  });
  afterEach(() => {
    h.close();
  });

  it("inserts a ledger row and bumps balance_millicents in lockstep", async () => {
    const org = await makeOrg();

    await appendLedger({
      orgId: org.id,
      deltaMillicents: 60_000,
      reason: "signup_bonus",
    });

    const db = getDb();
    const [orgRow] = await db
      .select({ balance: organizations.balanceMillicents })
      .from(organizations)
      .where(eq(organizations.id, org.id));
    expect(Number(orgRow.balance)).toBe(60_000);

    const ledgerRows = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.orgId, org.id));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].deltaMillicents).toBe(60_000);
  });

  it("subsequent debits and credits accumulate correctly", async () => {
    const org = await makeOrg();

    await appendLedger({
      orgId: org.id,
      deltaMillicents: 60_000,
      reason: "signup_bonus",
    });
    await appendLedger({
      orgId: org.id,
      deltaMillicents: -2_500,
      reason: "usage",
    });
    await appendLedger({
      orgId: org.id,
      deltaMillicents: 500_000,
      reason: "stripe_topup",
      stripeEventId: "evt_top_1",
    });

    expect(await getOrgCreditBalance(org.id)).toBe(60_000 - 2_500 + 500_000);
  });

  it("Stripe replay (duplicate stripe_event_id) is a no-op — ledger row not added, balance unchanged", async () => {
    const org = await makeOrg();

    const first = await appendLedger({
      orgId: org.id,
      deltaMillicents: 500_000,
      reason: "stripe_topup",
      stripeEventId: "evt_dup_1",
    });
    expect(first.duplicate).toBe(false);

    const second = await appendLedger({
      orgId: org.id,
      deltaMillicents: 500_000,
      reason: "stripe_topup",
      stripeEventId: "evt_dup_1",
    });
    expect(second.duplicate).toBe(true);

    expect(await getOrgCreditBalance(org.id)).toBe(500_000);

    const db = getDb();
    const ledger = await db.select().from(creditLedger);
    expect(ledger).toHaveLength(1);
  });

  it("recordStripeTopup is a thin wrapper and applies the same invariants", async () => {
    const org = await makeOrg();
    const r = await recordStripeTopup({
      orgId: org.id,
      stripeEventId: "evt_a",
      amountMillicents: 1_000_000,
      reason: "stripe_auto_topup",
    });
    expect(r.duplicate).toBe(false);
    expect(await getOrgCreditBalance(org.id)).toBe(1_000_000);
  });
});

describe("recordDailyUsage UPSERT", () => {
  let h: TestDbHandle;
  beforeEach(() => {
    h = setupTestDb();
  });
  afterEach(() => {
    h.close();
  });

  it("first event for a (org, user, day) inserts a fresh row", async () => {
    const org = await makeOrg();
    const u = await makeUser({ email: "alice@example.com" });
    const now = new Date();

    await recordDailyUsage({
      orgId: org.id,
      userId: u.id,
      occurredAt: now,
      wordCount: 12,
      audioMs: 3_500,
      retailCostMillicents: 240,
      upstreamCostMillicents: 38,
      polishApplied: true,
    });

    const db = getDb();
    const rows = await db.select().from(usageDaily);
    expect(rows).toHaveLength(1);
    expect(rows[0].events).toBe(1);
    expect(rows[0].wordCount).toBe(12);
    expect(rows[0].audioMs).toBe(3_500);
    expect(rows[0].costMillicents).toBe(240);
    expect(rows[0].upstreamCostMillicents).toBe(38);
    expect(rows[0].polishEvents).toBe(1);
    const dayMs = (rows[0].dayTs as Date).getTime();
    expect(dayMs).toBe(dayStart(now).getTime());
  });

  it("subsequent events on the same day update the same row by adding", async () => {
    const org = await makeOrg();
    const u = await makeUser({ email: "alice@example.com" });
    const now = new Date();

    await recordDailyUsage({
      orgId: org.id,
      userId: u.id,
      occurredAt: now,
      wordCount: 10,
      audioMs: 2_000,
      retailCostMillicents: 200,
      upstreamCostMillicents: 30,
      polishApplied: true,
    });
    await recordDailyUsage({
      orgId: org.id,
      userId: u.id,
      occurredAt: now,
      wordCount: 5,
      audioMs: 1_000,
      retailCostMillicents: 100,
      upstreamCostMillicents: null,
      polishApplied: false,
    });

    const db = getDb();
    const rows = await db.select().from(usageDaily);
    expect(rows).toHaveLength(1);
    expect(rows[0].events).toBe(2);
    expect(rows[0].wordCount).toBe(15);
    expect(rows[0].audioMs).toBe(3_000);
    expect(rows[0].costMillicents).toBe(300);
    expect(rows[0].upstreamCostMillicents).toBe(30);
    expect(rows[0].polishEvents).toBe(1);
  });

  it("events on different UTC days create separate rows", async () => {
    const org = await makeOrg();
    const u = await makeUser({ email: "alice@example.com" });
    const today = new Date();
    const yesterday = new Date(today.getTime() - MS_PER_DAY);

    await recordDailyUsage({
      orgId: org.id,
      userId: u.id,
      occurredAt: today,
      wordCount: 10,
      audioMs: null,
      retailCostMillicents: 200,
      upstreamCostMillicents: null,
      polishApplied: false,
    });
    await recordDailyUsage({
      orgId: org.id,
      userId: u.id,
      occurredAt: yesterday,
      wordCount: 7,
      audioMs: null,
      retailCostMillicents: 140,
      upstreamCostMillicents: null,
      polishApplied: false,
    });

    const db = getDb();
    const rows = await db
      .select()
      .from(usageDaily)
      .where(and(eq(usageDaily.orgId, org.id), eq(usageDaily.userId, u.id)));
    expect(rows).toHaveLength(2);
  });

  it("different users with same org+day get distinct rows", async () => {
    const org = await makeOrg();
    const a = await makeUser({ email: "a@example.com" });
    const b = await makeUser({ email: "b@example.com" });
    const now = new Date();

    await recordDailyUsage({
      orgId: org.id,
      userId: a.id,
      occurredAt: now,
      wordCount: 10,
      audioMs: null,
      retailCostMillicents: 200,
      upstreamCostMillicents: null,
      polishApplied: false,
    });
    await recordDailyUsage({
      orgId: org.id,
      userId: b.id,
      occurredAt: now,
      wordCount: 5,
      audioMs: null,
      retailCostMillicents: 100,
      upstreamCostMillicents: null,
      polishApplied: false,
    });

    const db = getDb();
    const rows = await db.select().from(usageDaily).where(eq(usageDaily.orgId, org.id));
    expect(rows).toHaveLength(2);
  });
});

describe("getOrgCreditBalance reads materialized column (not ledger sum)", () => {
  let h: TestDbHandle;
  beforeEach(() => {
    h = setupTestDb();
  });
  afterEach(() => {
    h.close();
  });

  it("returns the org row's balance_millicents, ignoring direct ledger inserts that bypass the helper", async () => {
    // This test pins down the new contract: getOrgCreditBalance is now
    // a single-row read of organizations.balance_millicents. If
    // someone bypasses appendLedger() and inserts directly into
    // credit_ledger, the materialized column will drift — and that
    // drift is exactly what this test asserts (so the failure mode
    // is loud the next time someone tries to bypass the helper).
    const org = await makeOrg();
    const db = getDb();

    // Direct insert — does NOT go through appendLedger.
    await db.insert(creditLedger).values({
      orgId: org.id,
      deltaMillicents: 999_999,
      reason: "adjustment",
    });

    expect(await getOrgCreditBalance(org.id)).toBe(0);
  });
});
