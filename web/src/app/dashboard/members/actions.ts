// Server actions for the members page. Each action is authz-gated via
// requireOrgAdmin — members-only operations don't exist on this page.
//
// Actions:
//   * inviteMember     — create invitations row + email accept link
//   * revokeInvitation — delete unaccepted invitation
//   * removeMember     — remove an org_members row (can't remove owner)
//   * updateMemberRole — promote/demote (owner only)

"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  invitations,
  orgMembers,
  organizations,
  users,
  type OrgRole,
} from "@/lib/db/schema";
import { requireOrgAdmin } from "@/lib/authz";
import { getCurrentOrgForUser } from "@/lib/orgs";
import { sendInvitationEmail } from "@/lib/email/invitation";

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["owner", "admin", "member"]).default("member"),
});

export type ActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string };

// --- invite ----------------------------------------------------------------

export async function inviteMember(formData: FormData): Promise<ActionResult> {
  try {
    const { user } = await requireOrgAdminForCurrentOrg();
    const orgId = await currentOrgIdOrThrow(user.id);

    const parsed = inviteSchema.safeParse({
      email: formData.get("email"),
      role: formData.get("role") || "member",
    });
    if (!parsed.success) {
      return { ok: false, error: "Enter a valid email address." };
    }
    const { email, role } = parsed.data;

    const db = getDb();

    // Don't invite someone who's already a member.
    const existingMember = await db
      .select({ userId: orgMembers.userId })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .where(and(eq(orgMembers.orgId, orgId), eq(users.email, email)))
      .limit(1);
    if (existingMember.length > 0) {
      return { ok: false, error: `${email} is already a member.` };
    }

    // Don't create a duplicate pending invitation; reuse the existing row if
    // one's pending for this (org, email).
    const existingInv = await db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.orgId, orgId),
          eq(invitations.email, email),
          isNull(invitations.acceptedAt)
        )
      )
      .limit(1);
    const existing = existingInv[0];

    let token: string;
    let expiresAt: Date;
    if (existing) {
      token = existing.token;
      expiresAt = existing.expiresAt;
    } else {
      token = randomHexToken();
      expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days
      await db.insert(invitations).values({
        orgId,
        email,
        role,
        token,
        invitedBy: user.id,
        expiresAt,
      });
    }

    // Send (or log in dev) the invitation email.
    const [orgRow] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    const orgName = orgRow?.name ?? "your workspace";
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
    const acceptUrl = `${siteUrl}/invite/${token}`;
    await sendInvitationEmail({
      to: email,
      orgName,
      inviterEmail: user.email,
      acceptUrl,
      expiresAt,
    });

    revalidatePath("/dashboard/members");
    return { ok: true, message: `Invitation sent to ${email}.` };
  } catch (err) {
    console.error("inviteMember failed:", err);
    return { ok: false, error: "Couldn't send the invitation. Try again." };
  }
}

// --- revoke ----------------------------------------------------------------

const revokeSchema = z.object({ invitationId: z.string().uuid() });

export async function revokeInvitation(formData: FormData): Promise<ActionResult> {
  try {
    const { user } = await requireOrgAdminForCurrentOrg();
    const orgId = await currentOrgIdOrThrow(user.id);

    const parsed = revokeSchema.safeParse({ invitationId: formData.get("invitationId") });
    if (!parsed.success) return { ok: false, error: "Bad request." };

    const db = getDb();
    await db
      .delete(invitations)
      .where(
        and(eq(invitations.id, parsed.data.invitationId), eq(invitations.orgId, orgId))
      );

    revalidatePath("/dashboard/members");
    return { ok: true };
  } catch (err) {
    console.error("revokeInvitation failed:", err);
    return { ok: false, error: "Couldn't revoke the invitation." };
  }
}

// --- remove ----------------------------------------------------------------

const removeSchema = z.object({ userId: z.string().uuid() });

export async function removeMember(formData: FormData): Promise<ActionResult> {
  try {
    const { user } = await requireOrgAdminForCurrentOrg();
    const orgId = await currentOrgIdOrThrow(user.id);

    const parsed = removeSchema.safeParse({ userId: formData.get("userId") });
    if (!parsed.success) return { ok: false, error: "Bad request." };

    if (parsed.data.userId === user.id) {
      return { ok: false, error: "Use Settings → Leave workspace to remove yourself." };
    }

    const db = getDb();

    // Block removing the last owner.
    const target = await db
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, parsed.data.userId)))
      .limit(1);
    if (target[0]?.role === "owner") {
      const owners = await db
        .select({ userId: orgMembers.userId })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, "owner")));
      if (owners.length <= 1) {
        return { ok: false, error: "Promote another member to owner first." };
      }
    }

    await db
      .delete(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, parsed.data.userId)));

    revalidatePath("/dashboard/members");
    return { ok: true };
  } catch (err) {
    console.error("removeMember failed:", err);
    return { ok: false, error: "Couldn't remove the member." };
  }
}

// --- role change (owner-only) ---------------------------------------------

const changeRoleSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["owner", "admin", "member"]),
});

export async function changeMemberRole(formData: FormData): Promise<ActionResult> {
  try {
    const { user, role: callerRole } = await requireOrgAdminForCurrentOrg();
    if (callerRole !== "owner") {
      return { ok: false, error: "Only owners can change roles." };
    }
    const orgId = await currentOrgIdOrThrow(user.id);

    const parsed = changeRoleSchema.safeParse({
      userId: formData.get("userId"),
      role: formData.get("role"),
    });
    if (!parsed.success) return { ok: false, error: "Bad request." };

    const db = getDb();
    await db
      .update(orgMembers)
      .set({ role: parsed.data.role as OrgRole })
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, parsed.data.userId)));

    revalidatePath("/dashboard/members");
    return { ok: true };
  } catch (err) {
    console.error("changeMemberRole failed:", err);
    return { ok: false, error: "Couldn't change the role." };
  }
}

// --- shared helpers --------------------------------------------------------

async function requireOrgAdminForCurrentOrg() {
  // The caller's "current org" is their first/only org in Phase 3. We require
  // admin for all mutations on this page. requireOrgMember resolves the org
  // first so we get a consistent error if they've somehow lost membership.
  const u = await import("@/lib/authz").then((m) => m.requireUser());
  const org = await getCurrentOrgForUser(u.id);
  if (!org) throw new Error("No current org");
  return requireOrgAdmin(org.id);
}

async function currentOrgIdOrThrow(userId: string): Promise<string> {
  const org = await getCurrentOrgForUser(userId);
  if (!org) throw new Error("No current org");
  return org.id;
}

/** Hex token for invitation links. 24 bytes → 48 hex chars; plenty of entropy. */
function randomHexToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

