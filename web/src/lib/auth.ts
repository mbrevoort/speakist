// Auth.js (NextAuth v5) configuration.
//
// Magic-link (email OTP) auth via Resend. Sessions stored in D1 via the
// Drizzle adapter. No passwords, no OAuth providers in v1 — the only way in
// is a magic link. Cheapest option, UX-appropriate for this product.
//
// Session strategy is "database" (row in `sessions`) rather than JWT because
// (a) we need server-side revocation for device-linked sessions in Phase 6,
// and (b) D1 reads are cheap enough.
//
// Dev convenience: when RESEND_API_KEY is unset, magic links are logged to
// the server console instead of emailed. See `sendVerificationRequest`.

import NextAuth, { type NextAuthConfig } from "next-auth";
import Resend from "next-auth/providers/resend";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import type { Adapter } from "next-auth/adapters";
import { getDb } from "@/lib/db";
import {
  accounts,
  sessions,
  users,
  verificationTokens,
} from "@/lib/db/schema";
import { provisionNewUser } from "@/lib/orgs";

/**
 * Build the Auth.js config. We build lazily because the Drizzle adapter needs
 * the D1 binding (via getCloudflareContext), which only exists inside a
 * request scope.
 */
export function buildAuthConfig(): NextAuthConfig {
  const db = getDb();

  return {
    adapter: DrizzleAdapter(db, {
      usersTable: users,
      accountsTable: accounts,
      sessionsTable: sessions,
      verificationTokensTable: verificationTokens,
    }) as Adapter,

    session: { strategy: "database" },

    pages: {
      signIn: "/auth/signin",
      verifyRequest: "/auth/verify-request",
      error: "/auth/error",
    },

    providers: [
      Resend({
        // Provider `id` stays "resend" (Auth.js convention, used by our
        // signIn("resend", …) calls). `name` is what the default UI would
        // render; ours doesn't use it, but we override it anyway so that if
        // the default UI ever surfaces (e.g. during a misconfig) it says
        // "Email" instead of the service we happen to buy delivery from.
        name: "Email",
        apiKey: process.env.RESEND_API_KEY ?? "resend-missing",
        from: process.env.RESEND_FROM_EMAIL ?? "noreply@speakist-dev.brevoortstudio.com",
        // Intercept the outgoing email so we can (a) log the link in dev and
        // (b) swap in our branded template in Phase 3. For Phase 1, default
        // behavior is fine and we only override the dev-logging case.
        async sendVerificationRequest({ identifier, url, provider }) {
          // Dev: RESEND_API_KEY unset → print the link instead of sending.
          if (!process.env.RESEND_API_KEY) {
            console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            console.log(`✉  Magic link for ${identifier}:`);
            console.log(`   ${url}`);
            console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
            return;
          }

          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${provider.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: provider.from,
              to: identifier,
              subject: "Your Speakist sign-in link",
              html: `
                <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:40px 24px;color:#1B1322">
                  <h1 style="color:#4A2C5A;font-size:22px;margin:0 0 16px">Sign in to Speakist</h1>
                  <p style="color:#4A2C5A;font-size:15px;line-height:1.5">Click the button below to sign in. This link expires in 24 hours.</p>
                  <div style="margin:32px 0">
                    <a href="${url}" style="background:#FF8A65;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px">Sign in to Speakist</a>
                  </div>
                  <p style="color:#666;font-size:13px;line-height:1.5">If you didn't request this, you can safely ignore it.</p>
                </div>
              `,
            }),
          });
          if (!res.ok) {
            const body = await res.text();
            throw new Error(`Resend send failed: ${res.status} ${body}`);
          }
        },
      }),
    ],

    callbacks: {
      async session({ session, user }) {
        // Surface our custom fields on the session so server components can
        // render gated UI (super-admin badges, etc.) without another DB hit.
        // The `as` casts widen Auth.js's default User/Session types to include
        // our schema's extras (isSuperAdmin); a proper fix is a next-auth.d.ts
        // module augmentation, but keeping this local avoids a typings rabbit
        // hole and only touches two assignments.
        if (session.user) {
          const u = user as typeof user & { isSuperAdmin?: boolean };
          const s = session.user as typeof session.user & {
            id: string;
            isSuperAdmin: boolean;
          };
          s.id = user.id;
          s.isSuperAdmin = u.isSuperAdmin ?? false;
        }
        return session;
      },
    },

    events: {
      async createUser({ user }) {
        // Fires once per new user, after the users row is inserted. We
        // either (a) auto-join them to an org whose auto_join_domain matches
        // their email domain, or (b) create their own "{name}'s Workspace"
        // org, add them as owner, and grant the signup bonus. See
        // src/lib/orgs.ts for the decision tree.
        if (!user.id) return;
        try {
          const result = await provisionNewUser(user.id);
          console.log(
            `[auth] provisioned new user ${user.email} → ${result.kind}${
              "orgId" in result ? ` (org=${result.orgId})` : ""
            }`
          );
        } catch (err) {
          // Don't block sign-in if provisioning partially fails. A logged-in
          // user with no org will land on /dashboard and the shell will
          // detect the missing org and show a "Provisioning failed" state,
          // which is better than losing the session entirely.
          console.error("[auth] provisionNewUser failed:", err);
        }
      },
    },

    trustHost: true, // Cloudflare Pages: trust the host header.
  };
}

// `NextAuth()` must be called at request-time (not module load) because
// `buildAuthConfig()` touches the D1 binding. We wrap in a helper and export
// the handlers the Next.js route file expects.
export async function getAuth() {
  const { handlers, signIn, signOut, auth } = NextAuth(buildAuthConfig());
  return { handlers, signIn, signOut, auth };
}
