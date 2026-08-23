# Speakist

Speakist is private push-to-talk dictation for macOS. Hold a global shortcut, speak, and release. Parakeet transcribes on the Mac, exact vocabulary rules are applied locally, and a guarded small local model cleans up presentation before text is inserted at the cursor.

Local transcription is the default for new installs. It requires no Speakist account, has no per-word charge, and works offline after the first model download. Existing users keep their current Cloud choice during upgrade and can switch engines in Settings. Speakist Cloud remains available for multilingual transcription, synced vocabulary, and optional cloud polish.

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
- Shared/ — Mac analytics wrapper
- web/ — Next.js and Cloudflare Worker website, account, and optional cloud API
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

Open http://localhost:3000. Local magic-link sign-in links are printed in the development server output when Resend is not configured.

If Developer ID signing is unavailable during local testing, use an ad-hoc identity:

    xcodebuild -project Speakist.xcodeproj -scheme Speakist -configuration Debug -derivedDataPath build -skipPackagePluginValidation -skipMacroValidation CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= test

## First-run experience

1. Grant microphone and Accessibility permissions.
2. Keep the recommended local engine or choose Speakist Cloud.
3. Let Parakeet and local cleanup models download and warm.
4. Choose a dictation shortcut.
5. Run the onboarding test dictation.
6. Optionally enable launch at login.

The first model download requires a network connection. After setup, local audio and transcript text stay on the Mac. Update checks and optional account or cloud features may still use the network.

## Transcription and cleanup safety

Parakeet handles English speech recognition on-device. Vocabulary replacement is exact and token-boundary-aware; acoustic fuzzy replacement is intentionally not used because it can turn ordinary words into names. The local cleanup model is gated: output that does not preserve the spoken word sequence is discarded and deterministic cleanup is used instead.

See docs/local-models.md and docs/local-cleanup-lm-benchmark.md for model and benchmark details.

## Release channels

- local — com.brevoort-studio.speakist.local, localhost backend, no update feed
- dev — com.brevoort-studio.speakist.dev, development backend and feed
- beta — com.brevoort-studio.speakist.beta, production backend and beta feed
- stable — com.brevoort-studio.speakist, production backend and stable feed

See docs/releasing.md and docs/cicd.md before shipping.
