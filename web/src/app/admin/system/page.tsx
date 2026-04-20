// Admin → system settings. Just the system-wide Deepgram key today;
// Phase 6 might add a global kill-switch and a few other knobs.

import { eq } from "drizzle-orm";
import { PageHeader } from "@/components/dashboard/page-header";
import { requireSuperAdmin } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { SystemDeepgramKey } from "./system-client";

export const metadata = { title: "System — Admin" };

export default async function AdminSystemPage() {
  await requireSuperAdmin();
  const db = getDb();
  const [row] = await db
    .select({ encrypted: appSettings.systemDeepgramKeyEncrypted })
    .from(appSettings)
    .where(eq(appSettings.id, 1))
    .limit(1);

  const encKeyMissing = !process.env.APP_ENCRYPTION_KEY;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="System"
        description="Platform-wide configuration that super-admins control."
      />

      {encKeyMissing && (
        <div className="mb-6 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-semibold text-destructive">APP_ENCRYPTION_KEY not set.</p>
          <p className="mt-1 text-muted-foreground">
            Generate with <code className="font-mono">openssl rand -base64 32</code>,
            put it in <code className="font-mono">.env.local</code>, restart{" "}
            <code className="font-mono">pnpm dev</code>. Encrypted-at-rest secrets
            (system key, per-org Deepgram overrides) can&apos;t be saved until it is.
          </p>
        </div>
      )}

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
