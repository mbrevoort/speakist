// Admin → system settings. Platform-wide knobs. Today: system-wide Deepgram
// key, and the "allow public org creation" toggle that gates whether
// brand-new signups auto-get a workspace.

import { eq } from "drizzle-orm";
import { PageHeader } from "@/components/dashboard/page-header";
import { requireSuperAdmin } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { AllowPublicOrgToggle, SystemDeepgramKey } from "./system-client";

export const metadata = { title: "System — Admin" };

export default async function AdminSystemPage() {
  await requireSuperAdmin();
  const db = getDb();
  const [row] = await db
    .select({
      encrypted: appSettings.systemDeepgramKeyEncrypted,
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
        <h2 className="text-lg font-semibold tracking-tight">System Deepgram key</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
          The fallback Deepgram key used by any org without its own override.
          Stored AES-GCM-encrypted with{" "}
          <code className="font-mono text-xs">APP_ENCRYPTION_KEY</code>.
        </p>
        <div className="mt-5">
          <SystemDeepgramKey hasKey={!!row?.encrypted} />
        </div>
      </section>
    </div>
  );
}
