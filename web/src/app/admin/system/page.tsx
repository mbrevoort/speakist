// Admin → system settings. Platform-wide knobs:
//   * Public signup toggle
//   * System Groq + Deepgram keys (encrypted at rest)
//   * Polish mode prompts (intuitive + prescriptive) — overrides for the
//     baked-in defaults; NULL falls back to the constants in
//     lib/transcription/polish.ts.

import { eq } from "drizzle-orm";
import { PageHeader } from "@/components/dashboard/page-header";
import { requireSuperAdmin } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { bakedInPromptForMode } from "@/lib/transcription/polish";
import {
  AllowPublicOrgToggle,
  PolishPromptEditor,
  SystemDeepgramKey,
  SystemGroqKey,
} from "./system-client";

export const metadata = { title: "System — Admin" };

export default async function AdminSystemPage() {
  await requireSuperAdmin();
  const db = getDb();
  const [row] = await db
    .select({
      deepgramEncrypted: appSettings.systemDeepgramKeyEncrypted,
      groqEncrypted: appSettings.systemGroqKeyEncrypted,
      polishIntuitive: appSettings.polishIntuitivePrompt,
      polishPrescriptive: appSettings.polishPrescriptivePrompt,
      allowPublicOrgCreation: appSettings.allowPublicOrgCreation,
    })
    .from(appSettings)
    .where(eq(appSettings.id, 1))
    .limit(1);

  const encKeyMissing = !process.env.APP_ENCRYPTION_KEY;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="System"
        description="Platform-wide configuration that super-admins control."
      />

      {encKeyMissing && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-semibold text-destructive">APP_ENCRYPTION_KEY not set.</p>
          <p className="mt-1 text-muted-foreground">
            Generate with <code className="font-mono">openssl rand -base64 32</code>,
            put it in <code className="font-mono">.env.local</code> (or set it
            as a Worker secret for deployed environments), restart. Encrypted-
            at-rest secrets (system key, per-org Deepgram overrides) can&apos;t
            be saved until it is.
          </p>
        </div>
      )}

      <section className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
        <h2 className="text-lg font-semibold tracking-tight">Public signup</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
          Controls whether brand-new email signups get a workspace auto-
          created. Turning this off makes the environment invite-only — useful
          for dev/staging. Invitations and auto-join domains still work
          independently.
        </p>
        <div className="mt-5">
          <AllowPublicOrgToggle
            initiallyEnabled={row?.allowPublicOrgCreation ?? true}
          />
        </div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
        <h2 className="text-lg font-semibold tracking-tight">System Groq key</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
          The fallback Groq key used by any org without its own override.
          Groq is the default provider for new orgs (English routes to
          Whisper Turbo, other languages to Whisper Large), so this key
          is load-bearing — without it, default-routed orgs can&apos;t
          transcribe. Stored AES-GCM-encrypted with{" "}
          <code className="font-mono text-xs">APP_ENCRYPTION_KEY</code>.
        </p>
        <div className="mt-5">
          <SystemGroqKey hasKey={!!row?.groqEncrypted} />
        </div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
        <h2 className="text-lg font-semibold tracking-tight">System Deepgram key</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
          Optional fallback key used only when a super admin explicitly
          routes an org to Deepgram via its allowed-models list. Default
          routing is Groq, so most orgs never touch this. Stored AES-GCM-
          encrypted with{" "}
          <code className="font-mono text-xs">APP_ENCRYPTION_KEY</code>.
        </p>
        <div className="mt-5">
          <SystemDeepgramKey hasKey={!!row?.deepgramEncrypted} />
        </div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
        <h2 className="text-lg font-semibold tracking-tight">Polish — Intuitive prompt</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
          System prompt used when a user has Polish enabled and selects
          the <em>Intuitive</em> mode. Empty (or whitespace-only) saves
          NULL, which falls back to the baked-in default below — useful
          for reverting after experimentation.
        </p>
        <div className="mt-5">
          <PolishPromptEditor
            mode="intuitive"
            current={row?.polishIntuitive ?? null}
            bakedInDefault={bakedInPromptForMode("intuitive")}
          />
        </div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
        <h2 className="text-lg font-semibold tracking-tight">Polish — Prescriptive prompt</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
          System prompt used when a user has Polish enabled and selects
          the <em>Prescriptive</em> mode. Conservative by design — only
          punctuation, capitalization, and clear grammar fixes; never
          touches meaning. Empty saves NULL → baked-in fallback.
        </p>
        <div className="mt-5">
          <PolishPromptEditor
            mode="prescriptive"
            current={row?.polishPrescriptive ?? null}
            bakedInDefault={bakedInPromptForMode("prescriptive")}
          />
        </div>
      </section>
    </div>
  );
}
