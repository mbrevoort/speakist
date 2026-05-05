// Server actions for the Settings page.
//
// Actions:
//   * updateOrgName             — admin+
//   * updateAutoJoinDomain      — admin+; empty string = clear
//   * setWorkspaceFeedback      — admin+; flips feedback_disabled
//   * leaveOrg                  — member leaves (blocked for sole owner)
//   * deleteOrg                 — owner-only; hard delete (cascade wipes rows)

"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  organizations,
  orgMembers,
  users,
  vocabularyEntries,
} from "@/lib/db/schema";
import { requireUser, requireOrgAdmin } from "@/lib/authz";
import { getCurrentOrgForUser } from "@/lib/orgs";

export type ActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string };

// --- polish (per-user) ----------------------------------------------------
//
// The Mac side speaks to /api/me/polish via fetch; in the dashboard we can
// hit the DB directly through a server action and skip the round trip.
// Schema mirrors the API contract: `enabled` is a boolean, `system_prompt`
// is `null` to clear (revert to default) or a non-empty string to set.

const polishToggleSchema = z.object({ enabled: z.enum(["on", "off"]) });

export async function setPolishEnabled(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const parsed = polishToggleSchema.safeParse({
      enabled: formData.get("enabled") ?? "off",
    });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    const db = getDb();
    await db
      .update(users)
      .set({ polishEnabled: parsed.data.enabled === "on" })
      .where(eq(users.id, user.id));

    revalidatePath("/dashboard/settings");
    return {
      ok: true,
      message:
        parsed.data.enabled === "on"
          ? "Polish enabled — every transcription gets cleaned up."
          : "Polish disabled — raw transcripts will be returned as-is.",
    };
  } catch (err) {
    console.error("setPolishEnabled failed:", err);
    return { ok: false, error: "Couldn't save." };
  }
}

const polishModeSchema = z.object({
  mode: z.enum(["intuitive", "prescriptive"]),
});

export async function setPolishMode(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const parsed = polishModeSchema.safeParse({
      mode: formData.get("mode"),
    });
    if (!parsed.success) return { ok: false, error: "Bad mode." };

    const db = getDb();
    await db
      .update(users)
      .set({ polishMode: parsed.data.mode })
      .where(eq(users.id, user.id));

    revalidatePath("/dashboard/settings");
    return {
      ok: true,
      message:
        parsed.data.mode === "intuitive"
          ? "Switched to Intuitive mode — polish will apply intent-based corrections."
          : "Switched to Prescriptive mode — polish will only fix punctuation and grammar.",
    };
  } catch (err) {
    console.error("setPolishMode failed:", err);
    return { ok: false, error: "Couldn't save." };
  }
}

// Note: per-user prompt customization was removed. The two mode prompts
// are now configured globally by super admins at /admin/system. End-user
// Settings only exposes the toggle + mode picker.

// --- vocabulary (per-user) -------------------------------------------------
//
// CRUD over `vocabulary_entries` for the signed-in user. The API at
// /api/vocabulary is what the Mac app talks to over HTTP; in the dashboard
// we hit the DB directly via server actions. Both code paths preserve the
// same invariants (soft delete via deletedAt, ownership check, unique
// (user_id, from_text, to_text)).

const fromSchema = z.string().trim().min(1).max(200);
const toSchema = z.string().trim().min(1).max(500);

const vocabAddSchema = z.object({
  from: fromSchema,
  to: toSchema,
  isProperNoun: z.enum(["on", "off"]).optional(),
});

export async function addVocabEntry(
  formData: FormData
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const parsed = vocabAddSchema.safeParse({
      from: formData.get("from"),
      to: formData.get("to"),
      isProperNoun: formData.get("isProperNoun") ?? "off",
    });
    if (!parsed.success) {
      return { ok: false, error: "Both From and To are required." };
    }

    const db = getDb();
    const now = new Date();
    // Mirrors the upsert semantics of POST /api/vocabulary so the same
    // (from, to) pair re-added (or recovered from a tombstone) updates
    // in place rather than creating a duplicate row.
    await db
      .insert(vocabularyEntries)
      .values({
        userId: user.id,
        fromText: parsed.data.from,
        toText: parsed.data.to,
        isProperNoun: parsed.data.isProperNoun === "on",
        lastSeen: now,
      })
      .onConflictDoUpdate({
        target: [
          vocabularyEntries.userId,
          vocabularyEntries.fromText,
          vocabularyEntries.toText,
        ],
        set: {
          isProperNoun: parsed.data.isProperNoun === "on",
          lastSeen: now,
          updatedAt: now,
          deletedAt: null,
        },
      });

    revalidatePath("/dashboard/settings");
    return { ok: true, message: "Added." };
  } catch (err) {
    console.error("addVocabEntry failed:", err);
    return { ok: false, error: "Couldn't save." };
  }
}

const vocabUpdateSchema = z.object({
  id: z.string().uuid(),
  from: fromSchema,
  to: toSchema,
  isProperNoun: z.enum(["on", "off"]),
});

export async function updateVocabEntry(
  formData: FormData
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const parsed = vocabUpdateSchema.safeParse({
      id: formData.get("id"),
      from: formData.get("from"),
      to: formData.get("to"),
      isProperNoun: formData.get("isProperNoun") ?? "off",
    });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    const db = getDb();
    const now = new Date();

    // Ownership check before mutating so a leaked id can't update someone
    // else's row.
    const [existing] = await db
      .select({ userId: vocabularyEntries.userId })
      .from(vocabularyEntries)
      .where(eq(vocabularyEntries.id, parsed.data.id))
      .limit(1);
    if (!existing || existing.userId !== user.id) {
      return { ok: false, error: "Entry not found." };
    }

    try {
      await db
        .update(vocabularyEntries)
        .set({
          fromText: parsed.data.from,
          toText: parsed.data.to,
          isProperNoun: parsed.data.isProperNoun === "on",
          updatedAt: now,
          deletedAt: null,
        })
        .where(eq(vocabularyEntries.id, parsed.data.id));
    } catch (err) {
      // Most likely a unique-constraint collision — another row already
      // owns the new (from, to). Return a friendly message instead of a
      // 500 so the UI can revert.
      console.error("updateVocabEntry conflict:", err);
      return {
        ok: false,
        error: "An entry with that From → To already exists.",
      };
    }

    revalidatePath("/dashboard/settings");
    return { ok: true, message: "Saved." };
  } catch (err) {
    console.error("updateVocabEntry failed:", err);
    return { ok: false, error: "Couldn't save." };
  }
}

const vocabDeleteSchema = z.object({ id: z.string().uuid() });

export async function deleteVocabEntry(
  formData: FormData
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const parsed = vocabDeleteSchema.safeParse({ id: formData.get("id") });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    const db = getDb();
    const now = new Date();

    // Soft delete + ownership scope in one shot. If the id doesn't belong
    // to the caller, the WHERE matches nothing and the call is a no-op.
    await db
      .update(vocabularyEntries)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(vocabularyEntries.id, parsed.data.id),
          eq(vocabularyEntries.userId, user.id)
        )
      );

    revalidatePath("/dashboard/settings");
    return { ok: true, message: "Deleted." };
  } catch (err) {
    console.error("deleteVocabEntry failed:", err);
    return { ok: false, error: "Couldn't delete." };
  }
}

const nameSchema = z.object({ name: z.string().trim().min(1).max(80) });

// --- feedback opt-out (workspace-level) -----------------------------------
//
// Workspace owners + admins toggle the "Report bad transcription" feature
// for everyone in the workspace. The column itself (`feedback_disabled`)
// has been around since the feedback corpus shipped (#50); this action
// moves the toggle from the super-admin /admin/orgs/[id] page (where
// it lived initially) onto the workspace's own Settings page so the
// people who own the data can flip it without filing a request.
//
// Super-admins can still see the current value at /admin/orgs/[id] —
// it's now read-only there.

const feedbackSchema = z.object({
  // "on" = feature ENABLED for the workspace (column = 0)
  // "off" = feature DISABLED for the workspace (column = 1)
  // The form button label and the column flip are inverses; this naming
  // matches user intent ("turn the feature on/off") rather than the
  // column's negative-polarity name.
  enabled: z.enum(["on", "off"]),
});

export async function setWorkspaceFeedback(
  formData: FormData
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const org = await getCurrentOrgForUser(user.id);
    if (!org) return { ok: false, error: "No current org." };
    await requireOrgAdmin(org.id);

    const parsed = feedbackSchema.safeParse({
      enabled: formData.get("enabled"),
    });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    const db = getDb();
    await db
      .update(organizations)
      .set({ feedbackDisabled: parsed.data.enabled === "off" })
      .where(eq(organizations.id, org.id));

    revalidatePath("/dashboard/settings");
    return {
      ok: true,
      message:
        parsed.data.enabled === "on"
          ? "Reporting enabled."
          : "Reporting disabled.",
    };
  } catch (err) {
    console.error("setWorkspaceFeedback failed:", err);
    return { ok: false, error: "Couldn't save." };
  }
}

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
          : `Anyone signing up with @${parsed.data} will now get a pending invitation to this workspace.`,
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
            "You're the only owner. Promote someone else to owner first, or delete the workspace.",
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
    return { ok: false, error: "Couldn't leave the workspace." };
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

    // Double-confirm: the form must echo the workspace slug exactly.
    const confirm = (formData.get("confirm") as string | null)?.trim().toLowerCase();
    if (confirm !== org.slug.toLowerCase()) {
      return {
        ok: false,
        error: `Type the workspace slug (${org.slug}) to confirm deletion.`,
      };
    }

    const db = getDb();
    await db.delete(organizations).where(eq(organizations.id, org.id));
    // FK cascades on org_members, invitations, vocabulary_entries (via user),
    // credit_ledger, usage_events already handle the sweep.
  } catch (err) {
    console.error("deleteOrg failed:", err);
    return { ok: false, error: "Couldn't delete the workspace." };
  }
  redirect("/");
}
