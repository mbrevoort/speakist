# Speakist

Speakist is private push-to-talk dictation for macOS. Hold a global shortcut, speak, and release. Speech recognition, exact vocabulary replacement, and guarded language-model cleanup all run on the Mac before text is inserted at the cursor.

Speakist requires no account, has no per-word charge, and works offline after its two models download. Recordings, transcripts, vocabulary, history, and usage telemetry stay on the Mac. The hosted backend remains in this repository temporarily so older releases can upgrade safely, but the current Mac app does not use it for dictation.

## Requirements

- Apple silicon Mac with macOS 14 or later
- Xcode 15 or later
- XcodeGen
- Node.js 20 or later
- pnpm 10.28.0
- A Cloudflare account only when working on the hosted backend

## Repository

- Speakist/ — macOS application
- SpeakistTests/ — native unit and regression tests
- web/ — public website, Mac downloads, and temporary legacy compatibility backend
- scripts/ — benchmarks and Mac release tooling
- docs/ — architecture, local models, CI/CD, and release notes
- project.yml — source of truth for the generated Xcode project

Do not edit Speakist.xcodeproj directly. Regenerate it from project.yml.

## Local setup

From the repository root:

    make project
    make build
    make test

The web app uses pnpm:

    cd web
    pnpm install --frozen-lockfile
    pnpm db:migrate:local
    pnpm db:seed:local
    pnpm dev

Open http://localhost:3000. Legacy magic-link links are still printed in the development server output when exercising compatibility routes without Resend.

If Developer ID signing is unavailable during local testing, use an ad-hoc identity:

    xcodebuild -project Speakist.xcodeproj -scheme Speakist -configuration Debug -derivedDataPath build -skipPackagePluginValidation -skipMacroValidation CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= test

## First-run experience

1. Review the on-device privacy boundary.
2. Let the speech-to-text model and large language model download and warm.
3. Grant microphone and Accessibility permissions.
4. Choose and test a dictation shortcut.
5. Optionally enable launch at login.

The first model download requires a network connection. After setup, dictation works offline. Sparkle update checks still use the network.

## Transcription and cleanup safety

The speech-to-text model handles English recognition on-device. Vocabulary replacement is exact and token-boundary-aware; acoustic fuzzy replacement is intentionally not used because it can turn ordinary words into names. The local language model is gated: output that does not preserve the spoken word sequence is discarded and deterministic cleanup is used instead.

See docs/local-models.md and docs/local-cleanup-lm-benchmark.md for model and benchmark details.

## Release channels

- local — com.brevoort-studio.speakist.local, no update feed
- dev — com.brevoort-studio.speakist.dev, development feed
- beta — com.brevoort-studio.speakist.beta, beta feed
- stable — com.brevoort-studio.speakist, stable feed

See docs/releasing.md and docs/cicd.md before shipping.
