# Releasing Speakist

This checklist prepares a local-first Mac release while retaining Speakist Cloud for users who choose it.

This release supports Apple silicon Macs running macOS 14 or later. The MLX
cleanup dependency is not shipped for Intel Macs; website requirements and the
arm64-only archive must remain aligned.

## Release boundary

This release is ready to publish when:

- Fresh installs default to Parakeet and local AI cleanup.
- Existing installs with completed onboarding and no prior engine key remain on Cloud.
- Explicit engine and cleanup choices survive upgrade.
- Onboarding requires the Parakeet transcription model before the first test,
  clearly reports its download progress and failures, and lets users continue
  with rules-only cleanup while the optional Qwen model downloads or is retried.
- Settings can switch both directions and accurately describe the data path.
- Exact vocabulary replacements work without fuzzy name substitution.
- Only explicit user edits are learned.
- Website copy presents local as free, private, and default, with Cloud as optional.
- Native and web tests, type checking, build, and runtime smoke tests pass.

## Version preparation

1. Choose the semantic version and release notes.
2. Confirm project.yml versions and channel configuration.
3. Run make project.
4. Review the generated diff and ensure only Speakist and SpeakistTests targets exist.
5. Confirm third-party notices cover FluidAudio, Parakeet model distribution, MLX packages, Hugging Face tooling, and the pinned cleanup model.

## Verification

    make test

    cd web
    pnpm test
    pnpm exec tsc --noEmit
    pnpm build

Also perform two manual upgrade scenarios using isolated preferences:

1. Fresh install: local selected, no sign-in prompt, models visibly download, test dictation succeeds.
2. Existing install: onboarding already complete with no engine key, Cloud remains selected; switching to local prepares models and succeeds.

Record a retained-audio regression with both proper-name aliases and ordinary near-sounding words. Require positive alias replacements and zero ordinary-word substitutions.

## Publish

Create a GitHub Release with the intended tag and notes. The production workflow deploys web and Mac independently, builds stable or beta, notarizes the Mac DMG, uploads it, and publishes the matching Sparkle entry.

After CI completes, verify the exact artifact rather than relying only on green jobs:

- Download endpoint redirects to the new DMG.
- DMG mounts and the app launches on the supported macOS version.
- codesign assessment and notarization ticket pass.
- Sparkle feed reports the expected version and build.
- Landing, FAQ, privacy, and terms pages show local-first copy.
- Optional Cloud sign-in and transcription still work for an existing account.

## Rollback

- Web: redeploy the last known-good commit and compatible migrations.
- Mac: republish the last known-good signed artifact and appcast entry for the affected channel.
- Data-path emergency: existing users can switch engines in Settings. Do not silently force Cloud or local for users who already chose.
- Model emergency: preserve Parakeet transcription and fall back from local AI cleanup to deterministic rules.

Do not publish a production release from an ad-hoc signed build.
