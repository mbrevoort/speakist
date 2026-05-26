// Server actions for /admin/polish-prompts.
//
// Two operations, both super-admin-gated and both producing a new
// row in `polish_prompt_versions`:
//
//   * saveNewPolishPromptVersion   — admin edits the prompt body and
//                                    submits. Creates source='admin'.
//   * rollbackPolishPromptVersion  — admin picks an older version to
//                                    restore. Domain layer copies its
//                                    body into a new row with
//                                    source='rollback'.
//
// Both delegate to the helpers in lib/polish-prompts.ts; we don't
// touch the table directly here. revalidatePath bumps the RSC page
// after each mutation so the version table reflects the new state.

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/authz";
import {
  createVersion,
  rollbackToVersion,
} from "@/lib/polish-prompts";

export type ActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string };

// Upper bound on body length is intentionally generous (8000 chars).
// The current real prompts are ~5KB; we want headroom for the agent
// to grow them as new fixtures land, but a 50KB paste is almost
// certainly a transcript-in-the-wrong-textarea accident.
const saveSchema = z.object({
  mode: z.enum(["intuitive", "prescriptive"]),
  body: z.string().max(8000),
  notes: z.string().trim().max(2000).optional(),
});

export async function saveNewPolishPromptVersion(
  formData: FormData
): Promise<ActionResult> {
  try {
    const user = await requireSuperAdmin();
    const parsed = saveSchema.safeParse({
      mode: formData.get("mode"),
      body: formData.get("body") ?? "",
      notes: (formData.get("notes") as string | null) || undefined,
    });
    if (!parsed.success) {
      return { ok: false, error: "Bad input — body must be ≤ 8000 chars." };
    }
    const v = await createVersion({
      mode: parsed.data.mode,
      body: parsed.data.body,
      notes: parsed.data.notes,
      source: "admin",
      createdByUserId: user.id,
    });
    revalidatePath("/admin/polish-prompts");
    return {
      ok: true,
      message: `${capitalize(parsed.data.mode)} v${v.version} saved.`,
    };
  } catch (err) {
    console.error("saveNewPolishPromptVersion failed:", err);
    // Domain-layer errors carry useful messages (empty body, etc.).
    // Surface them rather than a generic "Couldn't save."
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't save.",
    };
  }
}

const rollbackSchema = z.object({
  mode: z.enum(["intuitive", "prescriptive"]),
  targetVersionId: z.string().min(1),
  notes: z.string().trim().max(2000).optional(),
});

export async function rollbackPolishPromptVersion(
  formData: FormData
): Promise<ActionResult> {
  try {
    const user = await requireSuperAdmin();
    const parsed = rollbackSchema.safeParse({
      mode: formData.get("mode"),
      targetVersionId: formData.get("targetVersionId"),
      notes: (formData.get("notes") as string | null) || undefined,
    });
    if (!parsed.success) {
      return { ok: false, error: "Bad input." };
    }
    const v = await rollbackToVersion({
      mode: parsed.data.mode,
      targetVersionId: parsed.data.targetVersionId,
      notes: parsed.data.notes,
      createdByUserId: user.id,
    });
    revalidatePath("/admin/polish-prompts");
    return {
      ok: true,
      message: `${capitalize(parsed.data.mode)} rolled back — now v${v.version}.`,
    };
  } catch (err) {
    console.error("rollbackPolishPromptVersion failed:", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't roll back.",
    };
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
