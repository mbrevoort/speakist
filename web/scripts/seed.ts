// Dev seed script.
//
// Run with: pnpm db:seed
//
// Makes the environment usable immediately after `supabase db reset`:
//   1. Creates the super-admin user (email from $SUPER_ADMIN_EMAIL, defaults
//      to mike@brevoort.com) via the Supabase admin API. Because email
//      confirmations are on, we also auto-confirm it so you can sign in
//      locally without clicking a link.
//   2. Promotes that user to is_super_admin = true in profiles.
//   3. Creates a demo "Brevoort Studio" org and adds the super admin as owner.
//   4. Grants the signup bonus ($5) to the demo org so the credit balance is
//      non-zero for UI testing.
//
// Idempotent — safe to run repeatedly.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL ?? "mike@brevoort.com";

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
      "Load .env.local (try: `set -a; source .env.local; set +a; pnpm db:seed`)."
  );
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function findOrCreateUser(email: string): Promise<string> {
  // List by email — paginated, but we expect at most one match.
  const { data: list, error: listErr } = await sb.auth.admin.listUsers({ perPage: 200 });
  if (listErr) throw listErr;
  const existing = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (existing) {
    console.log(`· user ${email} already exists (${existing.id})`);
    return existing.id;
  }

  const { data, error } = await sb.auth.admin.createUser({
    email,
    email_confirm: true,  // skip the magic link for seed convenience
    user_metadata: { display_name: email.split("@")[0] },
  });
  if (error) throw error;
  if (!data.user) throw new Error("createUser returned no user");
  console.log(`✓ created user ${email} (${data.user.id})`);
  return data.user.id;
}

async function promoteToSuperAdmin(userId: string) {
  const { error } = await sb
    .from("profiles")
    .update({ is_super_admin: true })
    .eq("id", userId);
  if (error) throw error;
  console.log(`✓ promoted ${userId} to super admin`);
}

async function findOrCreateOrg(name: string, slug: string, ownerId: string) {
  const { data: existing } = await sb
    .from("organizations")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();

  if (existing) {
    console.log(`· org ${slug} already exists (${existing.id})`);
    return existing.id as string;
  }

  const { data, error } = await sb
    .from("organizations")
    .insert({ name, slug })
    .select("id")
    .single();
  if (error) throw error;
  console.log(`✓ created org ${slug} (${data.id})`);

  const { error: memErr } = await sb
    .from("org_members")
    .insert({ org_id: data.id, user_id: ownerId, role: "owner" });
  if (memErr) throw memErr;

  return data.id as string;
}

async function grantSignupBonusIfMissing(orgId: string) {
  const { data: existing } = await sb
    .from("credit_ledger")
    .select("id")
    .eq("org_id", orgId)
    .eq("reason", "signup_bonus")
    .maybeSingle();
  if (existing) {
    console.log(`· org ${orgId} already has a signup bonus`);
    return;
  }

  const { data: pricing, error: pricingErr } = await sb
    .from("pricing_config")
    .select("signup_bonus_millicents")
    .eq("id", 1)
    .single();
  if (pricingErr) throw pricingErr;

  const { error } = await sb.from("credit_ledger").insert({
    org_id: orgId,
    delta_millicents: pricing.signup_bonus_millicents,
    reason: "signup_bonus",
    note: "Automatic signup bonus (seed script)",
  });
  if (error) throw error;
  console.log(`✓ granted signup bonus to org ${orgId}`);
}

async function main() {
  console.log(`Seeding against ${SUPABASE_URL} …`);
  const userId = await findOrCreateUser(SUPER_ADMIN_EMAIL);
  await promoteToSuperAdmin(userId);
  const orgId = await findOrCreateOrg("Brevoort Studio", "brevoort-studio", userId);
  await grantSignupBonusIfMissing(orgId);
  console.log("\nSeed complete.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
