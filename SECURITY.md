# Reporting security issues in Speakist

Thanks for taking the time to report. Speakist handles audio,
authentication, and payments — privately disclosed reports are the
right path, not a public issue.

## How to report

Use GitHub's **[private vulnerability reporting](https://github.com/mbrevoort/speakist/security/advisories/new)**.
It opens a confidential thread between you and the maintainers; we
get a notification, you get a working channel to share details.

If GitHub's flow isn't an option, email **security@brevoort.com** with
"Speakist" in the subject line.

Please include:

- A description of the issue and the impact you observed (or
  believe is possible).
- Reproduction steps — ideally the smallest case that demonstrates
  the bug.
- Anything you already know about scope (which version, which
  surface — Mac app / iOS app / Web backend / MCP).
- Whether you've shared the details anywhere else.

Please **do not** include personal data, real user audio, or
production credentials in the report. A redacted minimum-repro is
strictly better than a full trace.

## What to expect

| Stage | Target |
|---|---|
| Acknowledgement | Within 72 hours |
| Initial triage + severity assessment | Within 7 days |
| Fix + coordinated disclosure | Depends on severity; we'll keep you posted |

We don't currently run a paid bounty program. We're happy to credit
reporters in the release notes for the fix, if you'd like that.

## In scope

The bits worth focusing your time on:

- **Audio path** — capture on the Mac/iOS clients, transport to
  `/api/transcribe`, processing inside the Worker, response back.
  Audio is *never* persisted server-side except when a user
  explicitly opts in to share a recording with a feedback report
  (`web/src/app/api/feedback`).
- **Authentication** — Auth.js magic-link sign-in, device-code flow
  for the Mac app, bearer refresh tokens for ongoing sessions,
  service tokens for MCP (`web/src/lib/service-tokens.ts`,
  `web/src/lib/authz.ts`).
- **Authorization** — `requireUser` / `requireOrgMember` /
  `requireSuperAdmin` / `requireUserFromRequest` wrappers in
  `web/src/lib/authz.ts`. Anything that bypasses these directly
  reads from `getDb()` is a smell.
- **Secret handling** — provider API keys at rest are AES-GCM
  encrypted with `APP_ENCRYPTION_KEY` (`web/src/lib/crypto.ts`).
  Per-org overrides and system-wide keys both go through this.
- **Payments** — Stripe Checkout for top-ups, off-session auto-
  top-up, webhook handling (`web/src/app/api/stripe/webhook`).
- **MCP surface** — the bearer-authed `/api/mcp` route + the tool
  registry in `web/src/lib/mcp/tools.ts`. Scope gating is enforced
  per-tool.
- **Cross-environment mirror** — the prod → dev polish-prompt mirror
  routes (`web/src/app/api/admin/polish-prompts/mirror*`).

## Out of scope

- **Third-party dependencies** running on currently-supported
  versions — report those upstream (Auth.js, Drizzle, Stripe SDK,
  PostHog, etc.). We'll bump them once the upstream fix lands.
- **Issues that require a compromised super-admin account** to
  exploit. Super admins can write to the system-wide keys, edit
  polish prompts, mint service tokens, etc. — that's the design;
  protect your super-admin account accordingly.
- **Self-hosted deployments using stale code** — please reproduce
  against a recent `main` first.
- **Social engineering** of users or maintainers.
- **Denial of service** at the infrastructure layer (Cloudflare's
  problem, not ours).
