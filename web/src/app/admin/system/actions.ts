// Admin → system settings action. One thing: set or clear the encrypted
// system-wide Deepgram key. This is the fallback key used by any org that
// doesn't have its own override.

"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { requireSuperAdmin } from "@/lib/authz";
import { encryptSecret, decryptSecret } from "@/lib/crypto";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

// --- System provider keys -------------------------------------------------
//
// Both providers go through the same shape — encrypt + write or null +
// write — so a single helper keeps the two server actions structurally
// identical. The differences are: which schema column to update, what
// "looks like a valid key" check to apply, and the user-facing copy in
// success/error messages.

const schema = z.object({ key: z.string().trim() });

interface ProviderKeySpec {
  /** Drizzle column setter — receives `{ [col]: encrypted }` or `{ [col]: null }`. */
  setColumn: (value: string | null) => Record<string, string | null>;
  /** Lightweight format check ("does this look like the right shape?"). */
  isValidFormat: (key: string) => boolean;
  /** "That doesn't look like a..." error returned when isValidFormat fails. */
  formatError: string;
  /** Human-readable label for log messages. */
  label: string;
}

async function setSystemProviderKey(
  formData: FormData,
  spec: ProviderKeySpec
): Promise<ActionResult> {
  try {
    await requireSuperAdmin();
    const parsed = schema.safeParse({ key: formData.get("key") || "" });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    const db = getDb();

    if (parsed.data.key === "") {
      await db
        .update(appSettings)
        .set(spec.setColumn(null))
        .where(eq(appSettings.id, 1));
      revalidatePath("/admin/system");
      return { ok: true, message: "System key cleared." };
    }

    if (!spec.isValidFormat(parsed.data.key)) {
      return { ok: false, error: spec.formatError };
    }

    const encrypted = await encryptSecret(parsed.data.key);
    await db
      .update(appSettings)
      .set(spec.setColumn(encrypted))
      .where(eq(appSettings.id, 1));

    revalidatePath("/admin/system");
    return { ok: true, message: "System key saved." };
  } catch (err) {
    console.error(`setSystem${spec.label}Key failed:`, err);
    if (String(err).includes("APP_ENCRYPTION_KEY")) {
      return {
        ok: false,
        error: "APP_ENCRYPTION_KEY not configured. Set it in .env.local first.",
      };
    }
    return { ok: false, error: "Couldn't save." };
  }
}

export async function setSystemDeepgramKey(formData: FormData): Promise<ActionResult> {
  return setSystemProviderKey(formData, {
    setColumn: (v) => ({ systemDeepgramKeyEncrypted: v }),
    // Deepgram project keys are base64ish 40-char strings.
    isValidFormat: (k) => /^[A-Za-z0-9_-]{20,}$/.test(k),
    formatError: "That doesn't look like a Deepgram key.",
    label: "Deepgram",
  });
}

export async function setSystemGroqKey(formData: FormData): Promise<ActionResult> {
  return setSystemProviderKey(formData, {
    setColumn: (v) => ({ systemGroqKeyEncrypted: v }),
    // Groq keys are prefixed `gsk_` followed by ~50 alphanumeric chars.
    // Accept either the prefixed form or a raw token long enough to plausibly
    // be a key — letting us paste a new format without a code change.
    isValidFormat: (k) => /^(gsk_)?[A-Za-z0-9_-]{30,}$/.test(k),
    formatError: "That doesn't look like a Groq key (expected gsk_…).",
    label: "Groq",
  });
}

// --- polish prompts (super-admin override of mode defaults) --------------
//
// `mode` selects which app_settings column to write. The string is bounded
// to 8000 chars (longer than any reasonable system prompt — including
// a generous chain-of-thought header — so accidents like pasting a
// transcript get rejected). Empty/whitespace-only stores NULL, which
// means "use the baked-in default in lib/transcription/polish.ts".

const polishPromptSchema = z.object({
  mode: z.enum(["intuitive", "prescriptive"]),
  prompt: z.string().max(8000),
});

export async function setPolishPrompt(formData: FormData): Promise<ActionResult> {
  try {
    await requireSuperAdmin();
    const parsed = polishPromptSchema.safeParse({
      mode: formData.get("mode"),
      prompt: formData.get("prompt") ?? "",
    });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    const trimmed = parsed.data.prompt.trim();
    const value = trimmed.length > 0 ? trimmed : null;

    const column =
      parsed.data.mode === "intuitive"
        ? { polishIntuitivePrompt: value }
        : { polishPrescriptivePrompt: value };

    const db = getDb();
    await db.update(appSettings).set(column).where(eq(appSettings.id, 1));

    revalidatePath("/admin/system");
    return {
      ok: true,
      message:
        value === null
          ? `${parsed.data.mode === "intuitive" ? "Intuitive" : "Prescriptive"} prompt reset to baked-in default.`
          : `${parsed.data.mode === "intuitive" ? "Intuitive" : "Prescriptive"} prompt saved.`,
    };
  } catch (err) {
    console.error("setPolishPrompt failed:", err);
    return { ok: false, error: "Couldn't save." };
  }
}

// --- allow_public_org_creation toggle -------------------------------------

const toggleSchema = z.object({ enabled: z.enum(["on", "off"]) });

export async function setAllowPublicOrgCreation(
  formData: FormData
): Promise<ActionResult> {
  try {
    await requireSuperAdmin();
    const parsed = toggleSchema.safeParse({ enabled: formData.get("enabled") ?? "off" });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    const db = getDb();
    await db
      .update(appSettings)
      .set({ allowPublicOrgCreation: parsed.data.enabled === "on" })
      .where(eq(appSettings.id, 1));

    revalidatePath("/admin/system");
    return {
      ok: true,
      message:
        parsed.data.enabled === "on"
          ? "Public signup re-enabled — new users get a workspace auto-created."
          : "Public signup disabled — new users without an invitation land on the waiting screen.",
    };
  } catch (err) {
    console.error("setAllowPublicOrgCreation failed:", err);
    return { ok: false, error: "Couldn't save." };
  }
}

// --- Slack webhooks (super-admin) ----------------------------------------
//
// Two destinations, identical shape: an encrypted URL + an enable flag.
// Each pair is independently configurable. Disabling preserves the URL
// so an admin can flip notifications back on without re-pasting.
//
// Slack's incoming-webhook URLs always start with the same prefix; we
// pin to https + the canonical hostname so a fat-fingered paste of an
// unrelated URL is caught at save time rather than at first notification.

const SLACK_DESTINATIONS = ["new_user", "topup", "feedback"] as const;
type SlackDestination = (typeof SLACK_DESTINATIONS)[number];

interface SlackDestSpec {
  /** Drizzle column setters for URL + enable flag. */
  setUrlColumn: (value: string | null) => Record<string, string | null>;
  setEnabledColumn: (value: boolean) => Record<string, boolean>;
  /** Pluck the destination's encrypted URL out of an app_settings row. */
  pickUrl: (row: typeof appSettings.$inferSelect) => string | null;
  label: string;
}

const SLACK_SPECS: Record<SlackDestination, SlackDestSpec> = {
  new_user: {
    setUrlColumn: (v) => ({ slackNewUserWebhookUrlEncrypted: v }),
    setEnabledColumn: (v) => ({ slackNewUserWebhookEnabled: v }),
    pickUrl: (row) => row.slackNewUserWebhookUrlEncrypted,
    label: "new-user",
  },
  topup: {
    setUrlColumn: (v) => ({ slackTopupWebhookUrlEncrypted: v }),
    setEnabledColumn: (v) => ({ slackTopupWebhookEnabled: v }),
    pickUrl: (row) => row.slackTopupWebhookUrlEncrypted,
    label: "top-up",
  },
  feedback: {
    setUrlColumn: (v) => ({ slackFeedbackWebhookUrlEncrypted: v }),
    setEnabledColumn: (v) => ({ slackFeedbackWebhookEnabled: v }),
    pickUrl: (row) => row.slackFeedbackWebhookUrlEncrypted,
    label: "feedback",
  },
};

const slackUrlSchema = z.object({
  destination: z.enum(SLACK_DESTINATIONS),
  url: z.string().trim(),
});

function looksLikeSlackWebhook(url: string): boolean {
  return /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]+$/.test(url);
}

export async function setSlackWebhookUrl(formData: FormData): Promise<ActionResult> {
  try {
    await requireSuperAdmin();
    const parsed = slackUrlSchema.safeParse({
      destination: formData.get("destination"),
      url: formData.get("url") ?? "",
    });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    const spec = SLACK_SPECS[parsed.data.destination];
    const db = getDb();

    if (parsed.data.url === "") {
      // Clearing the URL also forces the enable flag off — a notification
      // with no destination is dead weight, and leaving it on would let
      // a future paste accidentally route somewhere unintended.
      await db
        .update(appSettings)
        .set({ ...spec.setUrlColumn(null), ...spec.setEnabledColumn(false) })
        .where(eq(appSettings.id, 1));
      revalidatePath("/admin/system");
      return { ok: true, message: "Webhook cleared." };
    }

    if (!looksLikeSlackWebhook(parsed.data.url)) {
      return {
        ok: false,
        error: "That doesn't look like a Slack incoming-webhook URL (expected https://hooks.slack.com/services/...).",
      };
    }

    // First-save auto-enable: when there was no URL previously, the admin
    // is opting in by configuring it, so flip enabled to on. Rotations
    // (URL already set) preserve whatever enable state the admin chose,
    // so a paused destination stays paused on rotation.
    const [existing] = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.id, 1))
      .limit(1);
    const isFirstSave = !existing || !spec.pickUrl(existing);

    const encrypted = await encryptSecret(parsed.data.url);
    await db
      .update(appSettings)
      .set(
        isFirstSave
          ? { ...spec.setUrlColumn(encrypted), ...spec.setEnabledColumn(true) }
          : spec.setUrlColumn(encrypted)
      )
      .where(eq(appSettings.id, 1));

    revalidatePath("/admin/system");
    return {
      ok: true,
      message: isFirstSave
        ? "Webhook saved and enabled."
        : "Webhook saved.",
    };
  } catch (err) {
    console.error("setSlackWebhookUrl failed:", err);
    if (String(err).includes("APP_ENCRYPTION_KEY")) {
      return {
        ok: false,
        error: "APP_ENCRYPTION_KEY not configured. Set it in .env.local first.",
      };
    }
    return { ok: false, error: "Couldn't save." };
  }
}

const slackEnabledSchema = z.object({
  destination: z.enum(SLACK_DESTINATIONS),
  enabled: z.enum(["on", "off"]),
});

export async function setSlackWebhookEnabled(
  formData: FormData
): Promise<ActionResult> {
  try {
    await requireSuperAdmin();
    const parsed = slackEnabledSchema.safeParse({
      destination: formData.get("destination"),
      enabled: formData.get("enabled") ?? "off",
    });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    const spec = SLACK_SPECS[parsed.data.destination];
    const db = getDb();

    if (parsed.data.enabled === "on") {
      // Refuse to enable a destination with no URL configured — the
      // notification would silently no-op and an admin would think it
      // was working.
      const [row] = await db
        .select()
        .from(appSettings)
        .where(eq(appSettings.id, 1))
        .limit(1);
      if (!row || !spec.pickUrl(row)) {
        return {
          ok: false,
          error: "Set a webhook URL before enabling notifications.",
        };
      }
    }

    await db
      .update(appSettings)
      .set(spec.setEnabledColumn(parsed.data.enabled === "on"))
      .where(eq(appSettings.id, 1));

    revalidatePath("/admin/system");
    return {
      ok: true,
      message:
        parsed.data.enabled === "on"
          ? `${spec.label} notifications enabled.`
          : `${spec.label} notifications paused.`,
    };
  } catch (err) {
    console.error("setSlackWebhookEnabled failed:", err);
    return { ok: false, error: "Couldn't save." };
  }
}

const slackTestSchema = z.object({ destination: z.enum(SLACK_DESTINATIONS) });

/**
 * Post a one-off test message to the configured URL. Bypasses the
 * `enabled` flag so an admin can confirm the URL works before flipping
 * the toggle on. Decrypts in-process; if APP_ENCRYPTION_KEY is wrong
 * (or the stored ciphertext is corrupt) we surface that explicitly.
 */
export async function sendSlackWebhookTest(
  formData: FormData
): Promise<ActionResult> {
  try {
    await requireSuperAdmin();
    const parsed = slackTestSchema.safeParse({
      destination: formData.get("destination"),
    });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    const spec = SLACK_SPECS[parsed.data.destination];
    const db = getDb();
    const [row] = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.id, 1))
      .limit(1);
    const encrypted = row ? spec.pickUrl(row) : null;
    if (!encrypted) {
      return { ok: false, error: "No webhook URL saved yet." };
    }

    let url: string;
    try {
      url = await decryptSecret(encrypted);
    } catch (err) {
      console.error("sendSlackWebhookTest decrypt failed:", err);
      return {
        ok: false,
        error: "Couldn't decrypt the saved URL — check APP_ENCRYPTION_KEY.",
      };
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `:white_check_mark: Speakist test (${spec.label}) — Slack webhook is wired up.`,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      return {
        ok: false,
        error: `Slack rejected the post: ${res.status} ${body.slice(0, 200)}`,
      };
    }

    return { ok: true, message: "Test message sent." };
  } catch (err) {
    console.error("sendSlackWebhookTest failed:", err);
    return { ok: false, error: "Couldn't send test." };
  }
}
