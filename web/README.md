# Speakist web

Next.js and Cloudflare application for Speakist's public website, Mac download endpoint, optional Cloud accounts, billing, vocabulary sync, feedback, administration, and Cloud transcription APIs.

The Mac app's recommended local transcription path does not depend on this service.

## Local development

    pnpm install --frozen-lockfile
    pnpm db:migrate:local
    pnpm db:seed:local
    pnpm dev

Open http://localhost:3000.

If Resend is not configured, magic-link and device-link URLs are printed to the development server terminal. Do not commit local environment files, authentication codes, tokens, or secrets.

## Validation

    pnpm test
    pnpm exec tsc --noEmit
    pnpm build

## Environments

Cloudflare configuration lives in wrangler.toml. Local development uses D1 state under .wrangler. Development and production bindings, secrets, migrations, and deployment procedures are documented in ../docs/cicd.md.

## Native integration

The Mac app can use a device-code flow for optional Cloud sign-in. The backend validates the code, issues a bearer token, and exposes account, usage, vocabulary, feedback, and transcription endpoints. Local Parakeet dictation bypasses these APIs.
