// Server actions for the Settings page.
//
// Actions:
//   * updateOrgName          — admin+
//   * updateAutoJoinDomain   — admin+; empty string = clear
//   * leaveOrg               — member leaves (blocked for sole owner)
//   * deleteOrg              — owner-only; hard delete (cascade wipes rows)

"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { organizations, orgMembers } from "@/lib/db/schema";
import { requireUser, requireOrgAdmin } from "@/lib/authz";
import { getCurrentOrgForUser } from "@/lib/orgs";

export type ActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string };

const nameSchema = z.object({ name: z.string().trim().min(1).max(80) });

export async function updateOrgName(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const org = await getCurrentOrgForUser(user.id);
    if (!org) return { ok: false, error: "No current org." };
    await requireOrgAdmin(org.id);

    const parsed = nameSchema.safeParse({ name: formData.get("name") });
    if (!parsed.success) return { ok: false, error: "Name is required (1–80 chars)." };

    const db = getDb();
    await db
      .update(organizations)
      .set({ name: parsed.data.name })
      .where(eq(organizations.id, org.id));

    revalidatePath("/dashboard");
    revalidatePath("/dashboard/settings");
    return { ok: true, message: "Saved." };
  } catch (err) {
    console.error("updateOrgName failed:", err);
    return { ok: false, error: "Couldn't save." };
  }
}

// auto_join_domain: normalized to lowercase, stripped of leading "@" and
// protocol, validated as a plausible domain. Empty/null = feature off.
const domainSchema = z
  .string()
  .trim()
  .transform((s) =>
    s
      .replace(/^@/, "")
      .replace(/^https?:\/\//i, "")
      .toLowerCase()
  )
  .pipe(z.union([z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i), z.literal("")]));

export async function updateAutoJoinDomain(
  formData: FormData
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const org = await getCurrentOrgForUser(user.id);
    if (!org) return { ok: false, error: "No current org." };
    await requireOrgAdmin(org.id);

    const parsed = domainSchema.safeParse(formData.get("domain") ?? "");
    if (!parsed.success) return { ok: false, error: "Use a bare domain like acme.com (no @, no https)." };

    const db = getDb();
    // Enforce uniqueness at the application layer — DB has no unique
    // constraint on auto_join_domain so another org could theoretically
    // already claim it. First-claim-wins.
    if (parsed.data !== "") {
      const conflict = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(
          and(
            eq(organizations.autoJoinDomain, parsed.data),
            sql`${organizations.id} != ${org.id}`
          )
        )
        .limit(1);
      if (conflict.length > 0) {
        return {
          ok: false,
          error: `Another org already auto-joins @${parsed.data}.`,
        };
      }
    }

    await db
      .update(organizations)
      .set({ autoJoinDomain: parsed.data === "" ? null : parsed.data })
      .where(eq(organizations.id, org.id));

    revalidatePath("/dashboard");
    revalidatePath("/dashboard/settings");
    return {
      ok: true,
      message:
        parsed.data === ""
          ? "Auto-join turned off."
          : `Anyone signing up with @${parsed.data} will now auto-join.`,
    };
  } catch (err) {
    console.error("updateAutoJoinDomain failed:", err);
    return { ok: false, error: "Couldn't save." };
  }
}

// --- leave ----------------------------------------------------------------

export async function leaveOrg(): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const org = await getCurrentOrgForUser(user.id);
    if (!org) return { ok: false, error: "No current org." };

    const db = getDb();

    // Block if I'm the sole owner.
    if (org.role === "owner") {
      const owners = await db
        .select({ userId: orgMembers.userId })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.role, "owner")));
      if (owners.length <= 1) {
        return {
          ok: false,
          error:
            "You're the only owner. Promote someone else to owner first, or delete the org.",
        };
      }
    }

    await db
      .delete(orgMembers)
      .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, user.id)));

    // User now has no org; they land back on home where a new workspace will
    // *not* be auto-created (provisionNewUser only runs on Auth.js createUser).
    // Phase 4 will add a "create new workspace" flow for this edge case.
  } catch (err) {
    console.error("leaveOrg failed:", err);
    return { ok: false, error: "Couldn't leave the org." };
  }
  redirect("/");
}

// --- delete (owner-only) ---------------------------------------------------

export async function deleteOrg(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const org = await getCurrentOrgForUser(user.id);
    if (!org) return { ok: false, error: "No current org." };
    if (org.role !== "owner") return { ok: false, error: "Owners only." };

    // Double-confirm: the form must echo the org slug exactly.
    const confirm = (formData.get("confirm") as string | null)?.trim().toLowerCase();
    if (confirm !== org.slug.toLowerCase()) {
      return {
        ok: false,
        error: `Type the org slug (${org.slug}) to confirm deletion.`,
      };
    }

    const db = getDb();
    await db.delete(organizations).where(eq(organizations.id, org.id));
    // FK cascades on org_members, invitations, vocabulary_entries (via user),
    // credit_ledger, usage_events already handle the sweep.
  } catch (err) {
    console.error("deleteOrg failed:", err);
    return { ok: false, error: "Couldn't delete the org." };
  }
  redirect("/");
}
