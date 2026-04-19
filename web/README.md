# speakist.ai

Marketing site + SaaS backend for [Speakist](../README.md), the push-to-talk
dictation app for macOS. Built on Cloudflare end-to-end so it's $0 at zero
usage and stays cheap at scale.

## What lives here

- **Landing page + marketing** (Phase 2)
- **Account signup, org creation, invitations, dashboard** (Phase 3)
- **Credits + Stripe billing + usage dashboards** (Phase 4)
- **Super admin** for managing orgs, comp-ing accounts, setting pricing,
  configuring the system-wide Deepgram key (Phase 5)
- **Mac app sign-in backend** — device-code flow + short-lived Deepgram
  token minting + vocabulary sync (Phase 6)

## Stack

| Layer | Choice |
|---|---|
| Framework | **Next.js 15** (App Router) + TypeScript + Tailwind + shadcn/ui |
| Hosting / Runtime | **Cloudflare Workers** (with Static Assets) via **OpenNext** (`@opennextjs/cloudflare`) — entire app runs in one Worker; static assets served from the edge via the `ASSETS` binding; no commercial-use restriction, unlimited bandwidth free |
| Database | **Cloudflare D1** (managed SQLite, 5 GB free) |
| ORM | **Drizzle** (type-safe, tiny, SQLite-native) |
| Auth | **Auth.js v5** (NextAuth) — magic-link only, Drizzle adapter |
| Email | **Resend** (3K free/mo); dev falls back to logging to console |
| Payments | **Stripe** (Checkout + Customer Portal + webhooks) |

## Getting started

See [`SETUP.md`](./SETUP.md) — one page, fresh-clone to running dev env.

## Design principles

- **Money is stored as integer millicents** (1/1000 of a cent). Floats are
  ledger poison; per-word pricing at sub-cent precision would round to zero
  in integer cents. SQLite INTEGER is 64-bit, so we get $90 quintillion of
  headroom.
- **Credit ledger is append-only.** Every top-up and every spend is an
  immutable row; balance is `SUM(delta_millicents)`. Stripe events deduped
  via unique `stripe_event_id`.
- **Authorization is in code, not RLS.** SQLite doesn't have RLS, so every
  server route MUST go through the helpers in [`src/lib/authz.ts`](./src/lib/authz.ts)
  (`requireUser`, `requireOrgMember`, `requireSuperAdmin`). Bypassing this
  layer = security bug. There's no RLS safety net.
- **Transcripts never touch the server.** The Mac app reports `word_count`,
  `audio_ms`, and `model` for billing — not the transcript itself. The
  privacy promise on the marketing page is load-bearing.
- **Deepgram keys never leave the server.** Clients call Deepgram directly
  with short-lived, per-session keys minted by a Worker (Phase 6). Low
  latency + we stay in control of billing.
- **Dev and prod are fully separate.** Different D1 databases, different
  Cloudflare Pages projects, different env vars. There is no shared state.

## Repo layout

```
web/
├── src/
│   ├── app/                    # Next.js App Router
│   │   └── api/auth/[...nextauth]/route.ts
│   ├── components/ui/          # shadcn/ui primitives
│   ├── lib/
│   │   ├── db/
│   │   │   ├── index.ts        # Drizzle D1 client factory
│   │   │   └── schema.ts       # all tables
│   │   ├── auth.ts             # Auth.js config + Drizzle adapter
│   │   ├── authz.ts            # require{User,OrgMember,SuperAdmin} helpers
│   │   ├── env.ts              # zod-validated env parsing
│   │   └── utils.ts            # cn(), money helpers, device-code gen
│   └── middleware.ts           # minimal; per-route authz does the real work
├── drizzle/
│   └── migrations/
│       └── 0000_init.sql       # handwritten to match schema.ts exactly
├── scripts/
│   └── seed.sql                # super admin + demo org + $5 bonus
├── wrangler.toml               # Cloudflare Worker config (dev + production)
├── open-next.config.ts         # OpenNext adapter config
├── drizzle.config.ts           # drizzle-kit config
└── SETUP.md
```

## Costs

At zero usage: **$0/mo**, no card on file needed.

At ~100 paying users, ~150K transcriptions/mo: still likely **$0** (inside
D1 + Workers + Pages free tiers).

At 10K users: **$5–15/mo** all-in. Compare to Supabase Pro ($25/mo fixed)
+ Vercel Pro ($20/mo) = $45/mo baseline.
