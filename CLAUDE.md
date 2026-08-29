# Speakist repository guidance

Speakist is a local-only macOS push-to-talk dictation app with a Next.js and Cloudflare deployment for the public website, downloads, update feeds, and temporary compatibility routes for older binaries.

## Source of truth

The Xcode project is generated from project.yml. Never hand-edit Speakist.xcodeproj. Run make project after target, source, package, entitlement, or build-setting changes.

Use pnpm 10.28.0 for web work. Keep local D1 initialized before running backend tests or development mode.

## Product behavior

- New installs and existing upgrades use on-device speech recognition and guarded local language-model cleanup.
- The current Mac app has no sign-in, Cloud-transcription, feedback, analytics, evaluation, or vocabulary-synchronization path.
- Dictation audio, transcript text, vocabulary, history, and usage data stay on the Mac.
- Keep the legacy backend deployable until older binaries have had time to upgrade, but do not link its account or Cloud features from the current product flow.
- Vocabulary replacements are exact whole-token rules. Do not introduce fuzzy acoustic rewriting without a measured false-positive gate.
- Automatic cleanup must never be learned as a user correction. Learn only explicit edits made after processed text is shown.
- The cleanup model must preserve word content or fall back to deterministic cleanup.

## Common commands

    make project
    make build
    make test

    cd web
    pnpm install --frozen-lockfile
    pnpm db:migrate:local
    pnpm db:seed:local
    pnpm test
    pnpm dev

For local native tests when the Developer ID key is locked, use ad-hoc signing with CODE_SIGN_IDENTITY=-, CODE_SIGN_STYLE=Manual, and an empty DEVELOPMENT_TEAM.

## Verification

A build is not the final proof. Run native tests, web tests, type checking, and a local HTTP smoke test. For dictation changes, verify a real recording when permissions allow. For model or vocabulary changes, include positive replacements and ordinary-word false-positive regressions.

## Commits

Use focused conventional commits such as feat:, fix:, docs:, test:, and ci:. Do not commit credentials, local auth codes, ignored environment files, model caches, or retained user audio.
