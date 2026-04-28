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
  SlackWebhookCard,
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
      slackNewUserUrl: appSettings.slackNewUserWebhookUrlEncrypted,
      slackNewUserEnabled: appSettings.slackNewUserWebhookEnabled,
      slackTopupUrl: appSettings.slackTopupWebhookUrlEncrypted,
      slackTopupEnabled: appSettings.slackTopupWebhookEnabled,
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
            at-rest secrets (system key, per-workspace Deepgram overrides) can&apos;t
            be saved until it is.
          </p>
        </div>
      )}

      <section className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
        <h2 className="text-lg font-semibold tracking-tight">Public signup</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
          Controls whether brand-new email signups get a workspace auto-
          created. Turning this off makes the environment invite-only — useful
          for dev/staging. Manual invitations and per-workspace
          auto-invite domains still work independently.
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
          The fallback Groq key used by any workspace without its own
          override. Groq is the default provider for new workspaces
          (English routes to Whisper Turbo, other languages to Whisper
          Large), so this key is load-bearing — without it, default-
          routed workspaces can&apos;t transcribe. Stored AES-GCM-encrypted with{" "}
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
          routes a workspace to Deepgram via its allowed-models list.
          Default routing is Groq, so most workspaces never touch this. Stored AES-GCM-
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
        <h2 className="text-lg font-semibold tracking-tight">Slack notifications</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
          Optional. Post to a Slack channel when a new user signs in for
          the first time, and when a workspace tops up via Stripe
          (manual or auto). Use any{" "}
          <a
            className="underline underline-offset-2"
            href="https://api.slack.com/messaging/webhooks"
            target="_blank"
            rel="noreferrer"
          >
            incoming webhook
          </a>
          {" "}URL — stored AES-GCM-encrypted with{" "}
          <code className="font-mono text-xs">APP_ENCRYPTION_KEY</code>.
          Disable a destination to pause without losing the URL.
        </p>

        <div className="mt-5 space-y-6">
          <SlackWebhookCard
            destination="new_user"
            title="New user sign-in"
            description="Fires once per newly-provisioned user — i.e. the first magic-link sign-in. Includes their email, display name, and whether they got a fresh workspace or are awaiting acceptance of an invitation."
            hasUrl={!!row?.slackNewUserUrl}
            enabled={row?.slackNewUserEnabled ?? false}
          />
          <SlackWebhookCard
            destination="topup"
            title="Stripe top-up"
            description="Fires when a Stripe payment credits a workspace — both manual Checkout top-ups and off-session auto-top-ups. Includes the workspace name, amount in dollars, and which kind."
            hasUrl={!!row?.slackTopupUrl}
            enabled={row?.slackTopupEnabled ?? false}
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
