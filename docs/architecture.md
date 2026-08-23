# Speakist architecture

Speakist has two product surfaces:

1. A macOS app for push-to-talk dictation.
2. A Next.js and Cloudflare application for the landing page, downloads, accounts, billing, administration, and optional Cloud transcription.

## Native flow

    shortcut down
      -> record microphone audio
    shortcut up
      -> selected transcription engine
         -> local: Parakeet on Mac
         -> cloud: Speakist API and configured provider
      -> exact local vocabulary replacements
      -> selected cleanup
         -> deterministic speech cleanup
         -> guarded 4-bit local model with deterministic fallback
         -> optional Cloud polish on the Cloud path
      -> local history and optional retained audio
      -> paste at the focused cursor

Local mode never requires an account. Dictation audio and transcript text stay on the Mac. Model downloads, update checks, and optional account features can still use the network.

## Engine migration

The transcriptionEngine preference is an explicit migration boundary:

- If a stored engine exists, preserve it.
- If no engine exists but onboarding is already complete, persist Cloud to preserve established behavior.
- If no engine exists and onboarding is incomplete, default to Parakeet.

This allows an update to add a local-first default without silently changing the data path for existing users.

## Local model stack

Parakeet TDT v2 runs through FluidAudio and Core ML. The app downloads and caches model assets on first setup. It is currently English-only.

Local cleanup first applies deterministic normalization. The small 4-bit cleanup model may improve punctuation and presentation, but its output passes content-preservation gates. If it changes, adds, removes, answers, or completes content outside the allowed normalization contract, Speakist uses the deterministic result.

Vocabulary rules are exact, whole-token replacements. Earlier fuzzy acoustic rescoring caused severe false positives such as ordinary words becoming names, so that path is intentionally absent.

## Corrections

CorrectionStore owns local vocabulary rules. The app learns only explicit edits relative to the processed text the user saw. It must never diff raw ASR against an automatically cleaned final transcript, because doing so teaches cleanup output as vocabulary.

Cloud synchronization is active only while the Cloud engine is selected. Existing locally stored rules remain available when switching engines.

## Storage

- History and usage: local GRDB databases under Application Support.
- Optional recent audio: local Application Support archive, pruned by preferences.
- Vocabulary: local correction database; optionally synchronized for Cloud users.
- Account token: per-channel macOS Keychain item.
- Model assets: framework-managed local caches.
- Web account and billing data: Cloudflare D1 and related configured services.
- Cloud request audio and transcript text: processed in transit, not retained by Speakist servers.

## Web and Cloud

The web application serves marketing pages, the Mac download redirect, device-code sign-in, dashboard, billing, vocabulary, feedback, admin tools, and Cloud transcription endpoints.

Cloud transcription is not the default for new installs. It remains useful for multilingual speech recognition, synced account features, workspace administration, and optional server-side polish.

## Permissions

- Microphone: capture dictation.
- Accessibility: paste text at the cursor.
- System Audio Recording: mute other application audio during dictation; samples are discarded.

## Build system

project.yml is authoritative. make project regenerates Speakist.xcodeproj. The native target is Speakist and the test target is SpeakistTests.

## Channels

| Channel | Bundle ID | Backend | Update feed |
| --- | --- | --- | --- |
| local | com.brevoort-studio.speakist.local | localhost:3000 | none |
| dev | com.brevoort-studio.speakist.dev | development | development |
| beta | com.brevoort-studio.speakist.beta | production | beta |
| stable | com.brevoort-studio.speakist | production | stable |

Local mode remains functional even if the configured backend is unavailable.

