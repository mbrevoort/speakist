# Speakist — Claude Code guide

Push-to-talk dictation for Mac + iOS. Cloudflare Worker backend.
Source for [speakist.ai](https://speakist.ai). See
[README.md](README.md) and [docs/architecture.md](docs/architecture.md)
for the deep dive.

## Layout

```
Speakist/          Mac app (SwiftUI menu-bar utility)
SpeakistiOS/       iOS containing app
SpeakistKeyboard/  iOS custom keyboard extension
Shared/            Swift code shared across all three Apple targets
web/               Next.js backend on Cloudflare (Workers + D1 + R2)
docs/              Architecture, releasing, CI/CD, agent loop
scripts/           Release + signing + image-generation
```

## Commands

**Web** (always run from `web/`, not repo root):

```sh
cd web
pnpm dev              # local Worker against local D1
pnpm typecheck        # tsc --noEmit
pnpm test:run         # vitest run
pnpm db:migrate:local # apply drizzle migrations locally
pnpm bench:polish --tier baseline   # validate shipped defaults
```

**Mac / iOS** (from repo root):

```sh
make project          # regen Speakist.xcodeproj from project.yml
make run              # build + launch Debug (Local channel → localhost:3000)
make test
```

## Conventions and gotchas

- **Web tests + typecheck must stay green before committing.** No
  exceptions. `pnpm test:run && pnpm typecheck`.
- **Money is millicents (1/1000 of a cent), stored as integers.**
  Float-based money is a bug; per-word pricing is sub-cent.
- **D1 does NOT support multi-statement transactions.** Multi-step
  writes use sequential statements + unique-index safety nets.
  Examples in `web/src/lib/polish-prompts.ts`.
- **Every API route + server action goes through `requireUser` /
  `requireOrgMember` / `requireSuperAdmin` / `requireUserFromRequest`**
  in `web/src/lib/authz.ts`. Direct `getDb()` reads from route
  handlers are a smell.
- **Audio + transcripts never persist server-side.** The proxy
  streams to the upstream STT provider without writing to D1, R2,
  or logs. Only opt-in feedback rows + their audio attachments
  exist server-side (R2 bucket `*-feedback-audio-*`).
- **Polish prompts live in `polish_prompt_versions`** (D1, versioned,
  rollback-able). Baselines for fresh installs:
  `web/src/lib/transcription/default-polish-prompts.ts`. Don't write
  to the deprecated `app_settings.polish_*_prompt` columns — they're
  a fallback that'll be dropped in a future migration.
- **Drizzle migrations are hand-written SQL** in
  `web/drizzle/migrations/` (NNNN_*.sql). Don't use drizzle-kit
  generate — the existing migrations were authored carefully and
  must stay readable.
- **`Speakist.xcodeproj` is generated.** Edit `project.yml` and
  re-run `make project` instead. Same for the per-config Info.plist
  files.
- **`SPEAKIST_APPLE_TEAM_ID`** env var threads through Makefile,
  project.yml, and the release scripts. Don't hardcode the team ID.
- **GitHub Actions workflows** trigger an automated security
  reminder on edit — comment-only and literal-CLI-flag edits are
  fine; treat any input from `github.event.*.title` or `body` as
  untrusted and pipe through `env:` instead of inlining.
- **PostHog analytics** is gated on the `stable` channel only — dev
  / beta / local builds never report (see `Shared/Analytics.swift`).

## Schema conventions

- IDs: `text` UUIDs from `crypto.randomUUID()` at insert time
  (`$defaultFn(uuid)` in `web/src/lib/db/schema.ts`).
- Timestamps: `integer` Unix milliseconds via the local
  `timestampMs(name)` helper.
- Booleans: `integer` 0/1 via the local `bool(name)` helper.
- Enums: `text` with a TypeScript literal-union `$type<…>()` hint.
- Authorization is in code, not RLS. D1 doesn't have RLS.

## Where to read more

- **`docs/architecture.md`** — system overview, transcribe path,
  module layout, persistence model.
- **`docs/cicd.md`** — workflow design + secrets checklist.
- **`docs/releasing.md`** — manual Mac DMG release runbook.
- **`docs/feedback-agent.md`** — the active learning loop + MCP
  tools agents use to iterate polish prompts.
- **`docs/polish-prompt-mirror.md`** — prod→dev cross-env mirror.
- **`web/SETUP.md`** — local-dev setup from a fresh clone.
- **`web/DEPLOYING.md`** — deploy a new Cloudflare environment.
- **`SECURITY.md`** — disclosure flow + in-scope surface.

## Commit conventions

- Branch: `<your-handle>/<short-topic>`.
- Commit message: `<area>: <imperative summary>` (e.g.
  `polish: …`, `ios: …`, `feedback: …`, `ci(polish): …`). One- or
  two-sentence body explaining the why for any non-trivial change.
- Co-author trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`
  on Claude-assisted commits.
- Don't commit unless asked — local edits stay uncommitted until the
  human says "commit."
- Run `pnpm typecheck && pnpm test:run` in `web/` before staging if
  you touched anything under `web/`.
