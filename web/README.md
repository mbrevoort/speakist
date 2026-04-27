# speakist.ai

Marketing site + SaaS backend for [Speakist](../README.md) — push-to-
talk dictation for Mac and iOS. Built on Cloudflare end-to-end so it
runs at $0 with no users on file and stays cheap at scale.

## What lives here

- **Landing page + marketing**
- **Account signup, org creation, invitations, multi-org switching**
- **Credits + Stripe billing + usage dashboards**
- **Super admin** for org management, comp-ing accounts, setting
  pricing, configuring system Groq + DeepGram keys, editing the polish
  prompts (intuitive + prescriptive)
- **Mac + iOS sign-in backend** — device-code flow with at-sign-in
  workspace selection for multi-org users
- **`/api/transcribe`** — proxy to upstream STT providers (Groq
  Whisper by default, DeepGram available per-org), runs polish, debits
  credits inline, never persists audio or transcripts

## Stack

| Layer | Choice |
|---|---|
| Framework | **Next.js 15** (App Router) + TypeScript + Tailwind + shadcn/ui |
| Hosting | **Cloudflare Workers** with Static Assets via **OpenNext** (`@opennextjs/cloudflare`) — entire app in one Worker, assets served from the edge |
| Database | **Cloudflare D1** (managed SQLite) |
| ORM | **Drizzle** (TypeScript-native, SQLite-friendly) |
| Auth | **Auth.js v5** — magic-link only, Drizzle adapter |
| Email | **Resend** (3K free/mo); dev falls back to console |
| Payments | **Stripe** (Checkout + Customer Portal + webhooks) |
| Upstream STT | **Groq Whisper** (default for new orgs) and **DeepGram** (super-admin opt-in per org) |
| Polish LLM | **Groq llama-3.1-8b-instant** |

## Getting started

- Local dev: [`SETUP.md`](./SETUP.md) — fresh-clone to running dev env
- Deploying to Cloudflare: [`DEPLOYING.md`](./DEPLOYING.md)

## Design principles

- **Money is integer millicents** (1/1000 of a cent). Floats are ledger
  poison; per-word pricing at sub-cent precision would round to zero
  in integer cents.
- **Credit ledger is append-only.** Every top-up and spend is an
  immutable row; balance is `SUM(delta_millicents)`. Stripe events
  deduped on `stripe_event_id`.
- **Authorization is in code, not RLS.** D1 doesn't have RLS, so every
  server route must go through `requireUser` / `requireOrgMember` /
  `requireSuperAdmin` from [`src/lib/authz.ts`](./src/lib/authz.ts).
  Bypassing this layer is a security bug.
- **Audio + transcripts never persist server-side.** `/api/transcribe`
  streams audio to the upstream provider without writing to disk and
  returns the text in the response. The client (Mac or iOS) keeps the
  transcript locally; we keep only the metadata needed for billing
  (provider, model, audio_seconds, word_count) on `usage_events`.
- **Provider routing is server-side.** Clients send the user's chosen
  language; the server picks (provider, model) from the org's allowed-
  models list and the language. Clients never specify a provider.
- **Polish prompts are super-admin-only.** End users choose a mode
  (intuitive or prescriptive); the actual prompt strings live in
  `app_settings` and are edited at `/admin/system`.
- **Dev and prod are fully separate.** Different D1 databases,
  different Workers, different secrets, different Stripe modes.

## Repo layout

```
web/
├── src/
│   ├── app/
│   │   ├── (marketing)/                Landing page, value props, pricing
│   │   ├── auth/                       Magic-link sign-in
│   │   ├── link/                       Device-code confirmation + workspace picker
│   │   ├── invite/[token]/             Invitation acceptance flow
│   │   ├── dashboard/                  Authenticated org dashboard
│   │   │   ├── usage/                  Per-event log + per-day chart
│   │   │   ├── billing/                Top up, autopay, Stripe portal
│   │   │   ├── members/                Invite, list, role-change, remove
│   │   │   └── settings/               Polish toggle + mode, org name, auto-join domain, leave/delete
│   │   ├── admin/                      Super-admin pages
│   │   │   ├── orgs/[id]/              Per-org overrides (provider keys, allowed models)
│   │   │   ├── users/                  User search, comp toggle
│   │   │   ├── pricing/                Per-word rate, signup bonus
│   │   │   └── system/                 System Groq/DeepGram keys, polish prompts, public-signup toggle
│   │   └── api/
│   │       ├── auth/[...nextauth]/     Auth.js routes
│   │       ├── auth/device/            Device-code start/poll
│   │       ├── transcribe/             Audio in → transcript out (proxy to upstream)
│   │       ├── me/                     /api/me + /api/me/polish
│   │       └── stripe/                 Checkout + webhook handlers
│   ├── components/
│   │   ├── ui/                         shadcn-style primitives (button, dropdown, sheet, switch, …)
│   │   ├── marketing/                  Landing-page modules
│   │   ├── dashboard/                  Sidebar, topbar, mobile nav, nav-items
│   │   └── admin/                      Admin sidebar, mobile nav, nav-items
│   └── lib/
│       ├── db/
│       │   ├── index.ts                Drizzle D1 client factory
│       │   └── schema.ts               All tables
│       ├── auth.ts                     Auth.js + Drizzle adapter
│       ├── authz.ts                    require{User,OrgMember,SuperAdmin}
│       ├── orgs.ts                     getCurrentOrgForUser, multi-org resolver
│       ├── credits.ts                  Ledger + debit logic
│       ├── transcription/
│       │   ├── index.ts                dispatch() to upstream providers
│       │   ├── secrets.ts              Per-(org, provider) key resolution
│       │   ├── orgAccess.ts            Allowed-models gate + language→model resolver
│       │   └── polish.ts               Polish prompt resolution + LLM call + sanity check
│       └── env.ts                      zod-validated env parsing
├── drizzle/
│   └── migrations/                     Numbered handwritten SQL
├── scripts/
│   └── seed.sql                        Super admin + demo org + signup bonus
├── wrangler.toml                       Cloudflare Worker config (dev + prod)
├── open-next.config.ts                 OpenNext adapter config
└── drizzle.config.ts                   drizzle-kit config
```

## Cost ballparks

At zero usage: **$0/mo**, no card on file required.

At ~100 paying users / ~150K transcriptions per month: still likely
**$0** (within D1 + Workers free tiers), with the variable cost being
the upstream STT spend (Groq Whisper is roughly an order of magnitude
cheaper than DeepGram per minute for the same audio).

At 10K users: **$5–15/mo** infrastructure all-in. Compare to Supabase
Pro ($25/mo) + Vercel Pro ($20/mo) = $45/mo baseline.
