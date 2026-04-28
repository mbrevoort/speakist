// GET /api/me
//
// The Mac app calls this right after sign-in (and on launch if already signed
// in) to fetch enough user + org context to render the Settings → Account
// view: email, display name, org name/role, and the current balance so the
// Mac can surface low-credit hints proactively.
//
// Intentionally small payload — no usage history, no member list. The Mac
// doesn't render either.
//
// Auth: bearer (or session cookie for web debugging via /api/me in a
// browser tab). 401 on no session, 200 + body otherwise. If the user has no
// org (edge case after leaving/deleting the last one), `org` is null rather
// than error; the Mac shows a "set up a workspace" hint.

// DELETE /api/me
//
// Account deletion. Required by App Review guideline 5.1.1(v) — apps that
// allow account creation must also offer in-app account deletion. Web-only
// deletion (e.g., a "delete account" link in /dashboard) does not satisfy
// the rule; the path has to be reachable from the iOS app itself.
//
// Cascade strategy (no schema change required — relies on the existing
// onDelete: "cascade" relationships and the small set of nullable
// references):
//
//   1. For each org the user is a member of:
//        - Sole member → DELETE the org. The schema's cascades take care
//          of orgMembers, creditLedger, usageEvents, usageDaily, and
//          invitations belonging to that org.
//        - Multi-member → leave the org standing. Delete the user's own
//          usageEvents + usageDaily + orgMembers row in that org. Other
//          members keep their balance and history.
//   2. NULL out the user's id wherever it appears as a non-cascading
//      reference on rows that survive the user (creditLedger.createdBy,
//      releases.publishedBy). These are audit-trail columns; nulling
//      preserves the record without keeping a dangling pointer to a
//      deleted user.
//   3. DELETE invitations the user issued (invitations.invitedBy is
//      notNull + no cascade, so the FK would block the user delete).
//   4. DELETE the users row. Cascades everything that survives:
//      sessions, accounts, mac_sessions, vocabulary_entries, any
//      remaining orgMembers / usageDaily.
//
// 200 with `{ ok: true }` on success. The client clears its local
// keychain token after a 200 — there's no need for the server to issue
// a separate revoke call because the user row is gone (and all its
// sessions with it via cascade).

import { and, eq } from "drizzle-orm";
import { AuthzError, requireUserFromRequest } from "@/lib/authz";
import { getDb } from "@/lib/db";
import {
  creditLedger,
  deviceAuthCodes,
  invitations,
  orgMembers,
  organizations,
  releases,
  usageDaily,
  usageEvents,
  users,
} from "@/lib/db/schema";
import { getCurrentOrgForUser, getOrgCreditBalance } from "@/lib/orgs";
import { resolvePromptForMode, type PolishMode } from "@/lib/transcription/polish";

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await requireUserFromRequest(req);
    const org = await getCurrentOrgForUser(user.id);
    const balance = org ? await getOrgCreditBalance(org.id) : 0;

    // Polish prefs — one extra row read, cheap. Mac caches the result
    // so Settings renders with the right state on launch without a
    // second round-trip.
    const db = getDb();
    const [prefs] = await db
      .select({
        enabled: users.polishEnabled,
        mode: users.polishMode,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    const mode: PolishMode = (prefs?.mode as PolishMode) ?? "prescriptive";
    const prompt = await resolvePromptForMode(mode);

    return Response.json({
      id: user.id,
      email: user.email,
      display_name: user.displayName,
      is_super_admin: user.isSuperAdmin,
      org: org
        ? {
            id: org.id,
            name: org.name,
            slug: org.slug,
            role: org.role,
            is_comped: org.isComped,
            balance_millicents: balance,
          }
        : null,
      polish: {
        enabled: !!prefs?.enabled,
        mode,
        // The active prompt the server will use given the selected
        // mode, including any super-admin override from app_settings.
        // End users can't customize the prompt anymore — `is_custom`
        // and `default_prompt` are kept in the payload so older
        // clients that read them don't crash, but is_custom is
        // permanently false now.
        system_prompt: prompt,
        is_custom: false,
        default_prompt: prompt,
      },
    });
  } catch (err) {
    if (err instanceof AuthzError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    const user = await requireUserFromRequest(req);
    const db = getDb();

    // Step 1 — partition orgs by membership cardinality so we know
    // which to delete outright and which to scrub the user's data
    // from.
    const myMemberships = await db
      .select({ orgId: orgMembers.orgId })
      .from(orgMembers)
      .where(eq(orgMembers.userId, user.id));

    for (const { orgId } of myMemberships) {
      const allMembers = await db
        .select({ userId: orgMembers.userId })
        .from(orgMembers)
        .where(eq(orgMembers.orgId, orgId));

      if (allMembers.length <= 1) {
        // Sole member (or empty — a stale invariant we still want
        // to clean up). Drop the whole org; cascades the rest.
        await db.delete(organizations).where(eq(organizations.id, orgId));
      } else {
        // Multi-member: peel the user's data out, leave the org
        // running for the others.
        await db
          .delete(usageEvents)
          .where(and(eq(usageEvents.orgId, orgId), eq(usageEvents.userId, user.id)));
        await db
          .delete(usageDaily)
          .where(and(eq(usageDaily.orgId, orgId), eq(usageDaily.userId, user.id)));
        await db
          .delete(orgMembers)
          .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, user.id)));
      }
    }

    // Step 2 — null out non-cascading audit references on rows that
    // survive (typically credit_ledger.created_by for entries the
    // user created in orgs they no longer belong to, and any release
    // they may have published as super admin). Both columns are
    // nullable; the audit row itself is preserved.
    await db
      .update(creditLedger)
      .set({ createdBy: null })
      .where(eq(creditLedger.createdBy, user.id));
    await db
      .update(releases)
      .set({ publishedBy: null })
      .where(eq(releases.publishedBy, user.id));

    // Step 3 — invitations.invited_by is notNull + no cascade, so
    // the FK would block the user delete unless we wipe these. They
    // were invitations *from* the user; deleting them is correct
    // behavior anyway (the inviter is leaving).
    await db.delete(invitations).where(eq(invitations.invitedBy, user.id));

    // Belt-and-suspenders cleanup — usage_events.user_id is notNull
    // with no cascade, so anything we missed in the per-org loop
    // above (e.g., an event logged in an org the user already left)
    // would block the user delete. Delete-by-user is idempotent.
    await db.delete(usageEvents).where(eq(usageEvents.userId, user.id));

    // device_auth_codes.user_id is nullable but the FK is plain NO
    // ACTION, which still blocks the user delete in SQLite. These
    // are short-lived sign-in codes — drop them outright rather than
    // null-and-keep, the codes are useless without the linked user.
    await db.delete(deviceAuthCodes).where(eq(deviceAuthCodes.userId, user.id));

    // Step 4 — delete the user row. Cascades sessions, accounts,
    // mac_sessions, vocabulary_entries, and any remaining
    // orgMembers / usageDaily / device_auth_codes references.
    await db.delete(users).where(eq(users.id, user.id));

    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthzError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
