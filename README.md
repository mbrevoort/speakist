# Speakist

Push-to-talk dictation for macOS. Hold a shortcut, speak, release — transcribed text appears at your cursor in any app.

- **Product spec** → [docs/speakist-prd.md](docs/speakist-prd.md)
- **Architecture** → [docs/architecture.md](docs/architecture.md)
- **Web app & SaaS backend** → [web/](web/) ([setup](web/SETUP.md))

## Requirements

- macOS 14 Sonoma or newer
- Xcode 15+
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) — `brew install xcodegen`
- A running Speakist backend (see [`web/`](web/)) — handles authentication, minted Deepgram keys, and billing

## Building

```sh
# One-time: generate Speakist.xcodeproj from project.yml
make project

# Open in Xcode
open Speakist.xcodeproj

# Or build + run from the command line
make run
```

## First-run

1. Launch the app. Speakist lives in your menu bar only — no Dock icon.
2. Onboarding asks for **Microphone** and **Accessibility** permissions. Both are required.
3. Sign in with your Speakist account (opens in your browser; you enter the short code the app shows you). New accounts get **$5 in free credit**.
4. Hold **⌃⌘X** anywhere on your Mac, speak, release. Text appears at the cursor.

The Mac app never stores a Deepgram API key. The backend mints a short-lived (10-minute, scoped) Deepgram key per transcription; the Mac sends audio directly to Deepgram with that key. Your voice and transcripts never touch our servers.

### Pointing the Mac at a custom backend

Default is `http://localhost:3000` (matches running `web/` locally via `pnpm dev`). Change per-install with:

```sh
defaults write com.brevoort-studio.speakist apiBaseURL "https://speakist.ai"
# Then relaunch Speakist.
```

## Project layout

```
Speakist/
├── Account/          # API client + sign-in (device-code flow), Keychain token
├── App/              # @main, AppDelegate, DI container
├── MenuBar/          # NSStatusItem controller, programmatic glyph
├── Shortcut/         # Global shortcut manager (KeyboardShortcuts)
├── Recording/        # AVAudioEngine capture + device monitor
├── Transcription/    # Deepgram client + orchestrator (mints temp keys via backend)
├── Paste/            # Clipboard + synthetic Cmd+V + AX focus probe
├── Corrections/      # Diff engine, correction store, keyterm builder
├── History/          # SQLite-backed history + audio archive
├── Settings/         # Settings window (Account / General / …), Keychain, preferences
├── HUD/              # Recording overlay + live waveform
├── Onboarding/       # First-run flow (permissions → sign in)
├── Permissions/      # Mic + Accessibility helpers
├── Usage/            # Local rollups (server owns the billing ledger)
├── Updates/          # Sparkle integration
├── Logging/          # os.Logger + file sink
└── Resources/        # Asset catalog, brand colors

web/                  # Next.js SaaS backend on Cloudflare — see web/README.md
```

## Distribution (maintainers)

1. Set `DEVELOPMENT_TEAM` in `project.yml` to your Apple Developer Team ID.
2. Fill `SUPublicEDKey` with your Sparkle EdDSA public key.
3. `make archive` produces a signed, notarized DMG (requires `xcrun notarytool` credentials).

## License

Proprietary / personal use for now.
