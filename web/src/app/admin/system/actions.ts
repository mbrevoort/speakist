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
import { encryptSecret } from "@/lib/crypto";

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
