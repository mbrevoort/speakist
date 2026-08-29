# Speakist architecture

Speakist has two product surfaces:

1. A macOS app for push-to-talk dictation.
2. A Next.js and Cloudflare application for the landing page and downloads, plus temporary legacy account, billing, administration, and cloud-transcription compatibility.

## Native flow

    shortcut down
      -> record microphone audio
    shortcut up
      -> speech-to-text model on Mac
      -> exact local vocabulary replacements
      -> deterministic speech cleanup
      -> guarded 4-bit local language model with deterministic fallback
      -> local history and optional retained audio
      -> paste at the focused cursor

The Mac app has no account or hosted transcription path. Dictation audio, transcript text, vocabulary, and usage data stay on the Mac. Model downloads and update checks still use the network.

## Local-only migration

A versioned local-only onboarding marker is the migration boundary. Every fresh install and every pre-local-only upgrade must finish both model downloads before dictation is enabled. Legacy engine and account preferences are inert and existing Keychain tokens are left untouched for rollback safety.

## Local model stack

Parakeet TDT v2 runs through FluidAudio and Core ML. The app downloads and caches model assets on first setup. It is currently English-only.

Local cleanup first applies deterministic normalization. The small 4-bit cleanup model may improve punctuation and presentation, but its output passes content-preservation gates. If it changes, adds, removes, answers, or completes content outside the allowed normalization contract, Speakist uses the deterministic result.

Vocabulary rules are exact, whole-token replacements. Earlier fuzzy acoustic rescoring caused severe false positives such as ordinary words becoming names, so that path is intentionally absent.

## Corrections

CorrectionStore owns local vocabulary rules. The app learns only explicit edits relative to the processed text the user saw. It must never diff raw ASR against an automatically cleaned final transcript, because doing so teaches cleanup output as vocabulary.

Vocabulary is stored and applied locally. The Mac app does not synchronize or classify vocabulary through the backend.

## Storage

- History and usage: local GRDB databases under Application Support.
- Optional recent audio: local Application Support archive, pruned by preferences.
- Vocabulary: local correction database.
- Model assets: framework-managed local caches.
- Web account and billing data: Cloudflare D1 and related configured services.
- Cloud request audio and transcript text: processed in transit, not retained by Speakist servers.

## Web and legacy compatibility

The public web application serves local-only marketing pages and the Mac download redirect. Device-code sign-in, dashboard, billing, vocabulary, feedback, admin tools, and cloud-transcription endpoints remain deployed only so older binaries can upgrade; they are not linked from the current product flow.

## Permissions

- Microphone: capture dictation.
- Accessibility: paste text at the cursor.
- System Audio Recording: mute other application audio during dictation; samples are discarded.

## Build system

project.yml is authoritative. make project regenerates Speakist.xcodeproj. The native target is Speakist and the test target is SpeakistTests.

## Channels

| Channel | Bundle ID | Update feed |
| --- | --- | --- | --- |
| local | com.brevoort-studio.speakist.local | none |
| dev | com.brevoort-studio.speakist.dev | development |
| beta | com.brevoort-studio.speakist.beta | beta |
| stable | com.brevoort-studio.speakist | stable |
