# Speakist

Push-to-talk dictation for macOS. Hold a shortcut, speak, release — transcribed text appears at your cursor in any app.

- **Product spec** → [docs/speakist-prd.md](docs/speakist-prd.md)
- **Architecture** → [docs/architecture.md](docs/architecture.md)

## Requirements

- macOS 14 Sonoma or newer
- Xcode 15+
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) — `brew install xcodegen`
- A Deepgram API key

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
3. Paste your Deepgram API key in Settings → Transcription.
4. Hold **⌃⌘X** anywhere on your Mac, speak, release. Text appears at the cursor.

## Project layout

```
Speakist/
├── App/              # @main, AppDelegate, DI container
├── MenuBar/          # NSStatusItem controller, programmatic glyph
├── Shortcut/         # Global shortcut manager (KeyboardShortcuts)
├── Recording/        # AVAudioEngine capture + device monitor
├── Transcription/    # Deepgram client + orchestrator
├── Paste/            # Clipboard + synthetic Cmd+V + AX focus probe
├── Corrections/      # Diff engine, correction store, keyterm builder
├── History/          # SQLite-backed history + audio archive
├── Settings/         # Settings window, Keychain, preferences
├── HUD/              # Recording overlay + live waveform
├── Onboarding/       # First-run flow
├── Permissions/      # Mic + Accessibility helpers
├── Usage/            # Deepgram minute rollups
├── Updates/          # Sparkle integration
├── Logging/          # os.Logger + file sink
└── Resources/        # Asset catalog, brand colors
```

## Distribution (maintainers)

1. Set `DEVELOPMENT_TEAM` in `project.yml` to your Apple Developer Team ID.
2. Fill `SUPublicEDKey` with your Sparkle EdDSA public key.
3. `make archive` produces a signed, notarized DMG (requires `xcrun notarytool` credentials).

## License

Proprietary / personal use for now.
