# speakist.ai

Marketing site + SaaS backend for [Speakist](../README.md), the push-to-talk
dictation app for macOS.

## What lives here

- **Landing page + marketing** (Phase 2)
- **Account signup, org creation, invitations, dashboard** (Phase 3)
- **Credits + Stripe billing + usage dashboards** (Phase 4)
- **Super admin** for managing orgs, comp-ing accounts, setting pricing,
  configuring the system-wide Deepgram key (Phase 5)
- **Mac app sign-in backend** — device-code flow + short-lived Deepgram
  token minting + vocabulary sync (Phase 6)

## Stack

- Next.js 15 (App Router), TypeScript, Tailwind, shadcn/ui
- Supabase (Postgres + Auth + RLS) — see `supabase/migrations/`
- Stripe (Checkout + Customer Portal + webhooks)
- Resend for transactional email
- Vercel for hosting

## Getting started

See [`SETUP.md`](./SETUP.md) — one page, fresh-clone to running dev env.

## Design principles

- **Money is stored as BIGINT millicents** (1/1000 of a cent). Floating-point
  dollars are ledger poison; per-word pricing at sub-cent precision would
  round to zero in integer cents.
- **Credit ledger, not balance column.** Every top-up and every spend is an
  immutable row; the balance is `sum(delta_millicents)`. Stripe events are
  deduped via a unique `stripe_event_id`.
- **Writes to money tables are service-role only.** RLS lets members read
  their org's ledger and usage, but never write. Every mutation flows through
  a Next.js API route that authenticates the caller first.
- **Transcripts never touch the server.** The Mac app reports `word_count`,
  `audio_seconds`, and `model` for billing — not the transcript itself. The
  privacy promise on the marketing page is load-bearing.
- **Deepgram keys never leave the server.** Clients call Deepgram directly
  with short-lived, per-session keys minted by us (Phase 6). Low latency +
  we stay in control of billing.

## Repo layout

```
web/
├── src/
│   ├── app/            # Next.js App Router — pages, layouts, API routes
│   ├── components/
│   │   └── ui/         # shadcn/ui primitives
│   ├── lib/
│   │   ├── supabase/   # browser / server / admin clients + generated types
│   │   ├── env.ts      # zod-validated env parsing
│   │   └── utils.ts    # cn(), money formatting helpers
│   └── middleware.ts   # Supabase session-refresh middleware
├── supabase/
│   ├── config.toml     # `supabase start` config
│   └── migrations/     # SQL migrations (schema + RLS)
└── scripts/
    └── seed.ts         # Bootstrap super admin + demo org
```
