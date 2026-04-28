// Optional Slack incoming-webhook notifications.
//
// Two destinations, each independently configurable + enable-flagged at
// /admin/system:
//
//   * `new_user`  — fires once per newly-provisioned user (after the
//                   Auth.js createUser hook + provisionNewUser ran). The
//                   user just clicked their first magic link, so this is
//                   effectively "new sign-up landed."
//   * `topup`     — fires when a Stripe payment (manual Checkout or
//                   off-session auto-top-up) credits an org's balance.
//
// Both are fire-and-forget: any failure here is logged and swallowed so
// it never blocks the user-visible flow (sign-in or webhook ack). The
// only thing that affects user behavior is whether we *enqueue* the
// notification at all — that's gated on the per-destination enable flag.
//
// URLs are AES-GCM encrypted at rest with APP_ENCRYPTION_KEY (same
// envelope as system provider keys); we decrypt at post time.

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { decryptSecret } from "@/lib/crypto";

type Destination = "new_user" | "topup";

interface DestinationColumns {
  encrypted: string | null;
  enabled: boolean;
}

async function loadDestination(dest: Destination): Promise<DestinationColumns | null> {
  const db = getDb();
  const [row] = await db
    .select({
      newUserUrl: appSettings.slackNewUserWebhookUrlEncrypted,
      newUserEnabled: appSettings.slackNewUserWebhookEnabled,
      topupUrl: appSettings.slackTopupWebhookUrlEncrypted,
      topupEnabled: appSettings.slackTopupWebhookEnabled,
    })
    .from(appSettings)
    .where(eq(appSettings.id, 1))
    .limit(1);
  if (!row) return null;

  if (dest === "new_user") {
    return { encrypted: row.newUserUrl, enabled: row.newUserEnabled };
  }
  return { encrypted: row.topupUrl, enabled: row.topupEnabled };
}

interface SlackBlocksMessage {
  text: string;
  blocks?: unknown[];
}

/**
 * POST a Slack message to one of our configured destinations.
 *
 * Returns silently on any non-2xx so the caller's flow (sign-in, webhook
 * ack) is never coupled to Slack availability. The `enabled` flag is
 * checked here rather than at the caller so adding a new notification
 * site is just one function call away from "respects the admin toggle."
 */
async function postToSlack(dest: Destination, message: SlackBlocksMessage): Promise<void> {
  try {
    const cfg = await loadDestination(dest);
    if (!cfg || !cfg.enabled || !cfg.encrypted) return;

    let url: string;
    try {
      url = await decryptSecret(cfg.encrypted);
    } catch (err) {
      console.error(`[slack:${dest}] decrypt failed:`, err);
      return;
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      console.error(`[slack:${dest}] post failed: ${res.status} ${body}`);
    }
  } catch (err) {
    console.error(`[slack:${dest}] unexpected error:`, err);
  }
}

// --- public API ------------------------------------------------------------

export interface NewUserNotification {
  email: string;
  displayName: string | null;
  /**
   * Outcome from `provisionNewUser` so the message can distinguish a
   * brand-new workspace creation from an awaiting-acceptance state.
   * Useful for spotting unexpected funnel drops between sign-in and
   * org creation.
   */
  provisionKind:
    | "created-org"
    | "awaiting-acceptance"
    | "awaiting-invitation"
    | "skipped";
  orgName: string | null;
}

export async function notifyNewUser(n: NewUserNotification): Promise<void> {
  const who = n.displayName ? `${n.displayName} <${n.email}>` : n.email;
  const where =
    n.provisionKind === "created-org"
      ? `created new workspace *${n.orgName ?? "?"}*`
      : n.provisionKind === "awaiting-acceptance"
        ? "awaiting acceptance — has pending invitation(s)"
        : n.provisionKind === "awaiting-invitation"
          ? "awaiting invitation (public signup is off)"
          : "skipped";

  await postToSlack("new_user", {
    text: `:wave: New Speakist user — ${who} (${where})`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:wave: *New Speakist user signed in*\n${who}\n${where}`,
        },
      },
    ],
  });
}

export interface TopupNotification {
  orgName: string;
  /** "manual" = Checkout (interactive); "auto" = off-session auto-top-up. */
  kind: "manual" | "auto";
  /** Amount credited to the ledger, in millicents. Bonus already included. */
  amountMillicents: number;
  /** Optional — the user we attribute the action to (manual top-ups). */
  userEmail?: string | null;
}

export async function notifyTopup(n: TopupNotification): Promise<void> {
  const dollars = (n.amountMillicents / 100_000).toFixed(2);
  const who = n.userEmail ? ` by ${n.userEmail}` : "";
  const label = n.kind === "manual" ? "Manual top-up" : "Auto top-up";

  await postToSlack("topup", {
    text: `:moneybag: ${label} — *${n.orgName}* credited $${dollars}${who}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:moneybag: *${label}*\n*${n.orgName}* credited *$${dollars}*${who}`,
        },
      },
    ],
  });
}
