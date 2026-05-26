// Optional Slack incoming-webhook notifications.
//
// Four destinations, each independently configurable + enable-flagged at
// /admin/system:
//
//   * `new_user`      — fires once per newly-provisioned user (after
//                       the Auth.js createUser hook + provisionNewUser
//                       ran). The user just clicked their first magic
//                       link, so this is effectively "new sign-up
//                       landed."
//   * `topup`         — fires when a Stripe payment (manual Checkout
//                       or off-session auto-top-up) credits an org's
//                       balance.
//   * `feedback`      — fires on every successful POST /api/feedback
//                       when a user clicks "Report bad transcription."
//                       Useful for spotting quality-issue clusters as
//                       they come in.
//   * `prompt_update` — fires whenever a polish-prompt version is
//                       written via lib/polish-prompts.ts. Covers
//                       admin edits, agent proposals (via the MCP
//                       `propose_polish_prompt` tool), rollbacks, and
//                       prod→dev mirrors. Low-volume signal kept on a
//                       separate webhook from feedback so the two
//                       don't share a channel.
//
// All destinations are fire-and-forget: any failure here is logged and
// swallowed so it never blocks the user-visible flow (sign-in, webhook
// ack, feedback submission, prompt write). The only thing that affects
// user behavior is whether we *enqueue* the notification at all —
// gated on the per-destination enable flag.
//
// URLs are AES-GCM encrypted at rest with APP_ENCRYPTION_KEY (same
// envelope as system provider keys); we decrypt at post time.
//
// Branding: every message posts as a `Speakist` user with the speakist.ai
// favicon as its avatar so the Slack timeline reads as one coherent
// system bot rather than three disconnected webhooks.

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { truncate } from "@/lib/utils";

type Destination = "new_user" | "topup" | "feedback" | "prompt_update";

/** Display name on every Slack message we post. Slack uses this for
 *  the bot row in the channel timeline. */
const WEBHOOK_USERNAME = "Speakist";

/** Public URL of the Speakist icon, used as the bot avatar in Slack.
 *  Served by Next.js from `web/src/app/icon.png` (the same favicon
 *  the marketing site uses), so it's the same brand asset the user
 *  sees in their browser tab. The path is stable across env URLs;
 *  prod resolves to https://speakist.ai/icon.png, dev to the
 *  speakist-dev hostname. Slack caches the image — if you ever swap
 *  the icon, bump the file's hash + restart the workspace's cache by
 *  editing the webhook display name once. */
const WEBHOOK_ICON_PATH = "/icon.png";
function webhookIconUrl(): string {
  return new URL(WEBHOOK_ICON_PATH, env.public.NEXT_PUBLIC_SITE_URL).toString();
}

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
      feedbackUrl: appSettings.slackFeedbackWebhookUrlEncrypted,
      feedbackEnabled: appSettings.slackFeedbackWebhookEnabled,
      promptUpdateUrl: appSettings.slackPromptUpdateWebhookUrlEncrypted,
      promptUpdateEnabled: appSettings.slackPromptUpdateWebhookEnabled,
    })
    .from(appSettings)
    .where(eq(appSettings.id, 1))
    .limit(1);
  if (!row) return null;

  switch (dest) {
    case "new_user":
      return { encrypted: row.newUserUrl, enabled: row.newUserEnabled };
    case "topup":
      return { encrypted: row.topupUrl, enabled: row.topupEnabled };
    case "feedback":
      return { encrypted: row.feedbackUrl, enabled: row.feedbackEnabled };
    case "prompt_update":
      return { encrypted: row.promptUpdateUrl, enabled: row.promptUpdateEnabled };
  }
}

interface SlackBlocksMessage {
  text: string;
  blocks?: unknown[];
}

/**
 * POST a Slack message to one of our configured destinations. Wraps the
 * caller's payload with a consistent `username` + `icon_url` so all
 * three destinations share Speakist branding in the Slack timeline.
 *
 * Returns silently on any non-2xx so the caller's flow (sign-in, webhook
 * ack, feedback submission) is never coupled to Slack availability.
 * The `enabled` flag is checked here rather than at the caller so adding
 * a new notification site is just one function call away from "respects
 * the admin toggle."
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

    const payload = {
      ...message,
      username: WEBHOOK_USERNAME,
      icon_url: webhookIconUrl(),
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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

export interface FeedbackNotification {
  feedbackId: string;
  userEmail: string;
  orgName: string;
  /** Failure category the user picked, or null if they skipped it. */
  failureKind: "wrong_word" | "punctuation" | "both" | "other" | null;
  /** Whether the user shared the audio recording with the report. */
  audioShared: boolean;
  /** What we delivered. Truncated to a Slack-friendly preview length. */
  polishedText: string;
  /** What the user said it should have been. Truncated similarly. */
  expectedText: string;
  /** Optional free-form note from the user. */
  userNote: string | null;
  /** Absolute URL to the admin detail page so the operator can jump
   *  straight to triage from the Slack message. */
  detailUrl: string;
}

export async function notifyFeedback(n: FeedbackNotification): Promise<void> {
  const kind = n.failureKind ? `*${n.failureKind.replace("_", " ")}*` : "_unspecified_";
  const audio = n.audioShared ? " · :microphone: audio shared" : "";
  const note = n.userNote ? `\n_${truncate(n.userNote, 200)}_` : "";

  // Slack's mrkdwn renders > as a quote prefix per line; manually
  // prepend so multi-line transcripts indent cleanly. Capping each
  // text block at 280 chars keeps the message height reasonable —
  // operators click through to the detail page for the full thing.
  const polished = quoted(truncate(n.polishedText, 280));
  const expected = quoted(truncate(n.expectedText, 280));

  await postToSlack("feedback", {
    text: `:flag-on-post: Feedback from ${n.userEmail} (${n.orgName})`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:flag-on-post: *Bad transcription reported* — ${kind}${audio}\n${n.userEmail} · ${n.orgName}${note}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Polished (delivered)*\n${polished}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Expected (user)*\n${expected}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Triage" },
            url: n.detailUrl,
          },
        ],
      },
    ],
  });
}

function quoted(s: string): string {
  return s.split("\n").map((line) => `> ${line}`).join("\n");
}

// ---- prompt_update --------------------------------------------------------

export interface PromptUpdateNotification {
  /** Polish mode the new version is for. */
  mode: "intuitive" | "prescriptive";
  /** Version number assigned to the new row. */
  newVersion: number;
  /** Provenance of the write — drives the header tone + actor copy. */
  source: "admin" | "agent" | "rollback" | "mirror" | "seed";
  /** Caller-supplied notes (already auto-prefixed for rollbacks). */
  notes: string | null;
  /** New version's score (0..1) or null when no bench was run. */
  benchScore: number | null;
  /** Score change vs the previous active version, or null when
   *  either the previous active had no score or no previous active
   *  existed. Used to flag regressions in the message header. */
  benchScoreDelta: number | null;
  /** Human-readable attribution — email for admin writes, token
   *  label for agent writes, "system" for seeds/mirrors. */
  actor: string;
  /** Absolute URL the action button links to. The admin page
   *  doesn't deep-link to a specific version yet; surfacing the
   *  page is enough for an operator to find the new row. */
  detailUrl: string;
}

/** Headline emoji picks by source + bench-delta sign:
 *   * rollback         → :rewind:
 *   * regression       → :warning:        (delta < 0)
 *   * agent improvement→ :sparkles:       (agent + delta >= 0)
 *   * default          → :pencil:
 */
function promptHeaderEmoji(
  source: PromptUpdateNotification["source"],
  delta: number | null
): string {
  if (source === "rollback") return ":rewind:";
  if (delta != null && delta < 0) return ":warning:";
  if (source === "agent") return ":sparkles:";
  return ":pencil:";
}

export async function notifyPromptUpdate(
  n: PromptUpdateNotification
): Promise<void> {
  const emoji = promptHeaderEmoji(n.source, n.benchScoreDelta);
  const headerText = `${emoji} *Polish prompt updated* — *${n.mode}* v${n.newVersion}`;

  const benchLine =
    n.benchScore == null
      ? "_no bench_"
      : n.benchScoreDelta == null
        ? `bench *${n.benchScore.toFixed(2)}*`
        : `bench *${n.benchScore.toFixed(2)}* (${
            n.benchScoreDelta >= 0 ? "+" : ""
          }${n.benchScoreDelta.toFixed(2)})`;

  const contextLine = `source: \`${n.source}\` · by ${n.actor} · ${benchLine}`;
  // Keep notes preview reasonable — operators click through for the
  // full body. 400 chars renders as ~4 lines in Slack mrkdwn.
  const notesPreview = n.notes ? quoted(truncate(n.notes, 400)) : null;

  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: headerText },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: contextLine }],
    },
  ];
  if (notesPreview) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: notesPreview },
    });
  }
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Open in admin" },
        url: n.detailUrl,
      },
    ],
  });

  await postToSlack("prompt_update", {
    text: `${emoji} Polish prompt updated — ${n.mode} v${n.newVersion} by ${n.actor}`,
    blocks,
  });
}
