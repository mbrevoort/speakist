# Releasing Speakist

This checklist prepares the local-only Mac release while retaining the hosted backend temporarily for older binaries.

This release supports Apple silicon Macs running macOS 14 or later. The MLX
cleanup dependency is not shipped for Intel Macs; website requirements and the
arm64-only archive must remain aligned.

## Release boundary

This release is ready to publish when:

- Fresh installs and existing upgrades enter the versioned local-only onboarding.
- Onboarding automatically downloads both required models, reports progress and
  failures clearly, and does not offer engine or model choices.
- Dictation remains disabled until both models are ready.
- Settings accurately describe the local data path and expose only progress,
  retry, English support, and diagnostics.
- Exact vocabulary replacements work without fuzzy name substitution.
- Only explicit user edits are learned.
- The public website presents one private, free, Mac-only product with no account.
- The Mac app has no third-party product analytics, cloud transcription,
  account, feedback, evaluation, or vocabulary-sync runtime path.
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

1. Fresh install: no sign-in prompt, both models visibly download, test dictation succeeds.
2. Existing install: preload a legacy Cloud preference and token, then verify the
   local-only onboarding appears, both models prepare, and offline dictation succeeds.

Record a retained-audio regression with both proper-name aliases and ordinary near-sounding words. Require positive alias replacements and zero ordinary-word substitutions.

## Publish

Create a GitHub Release with the intended tag and notes. The production workflow deploys web and Mac independently, builds stable or beta, notarizes the Mac DMG, uploads it, and publishes the matching Sparkle entry.

After CI completes, verify the exact artifact rather than relying only on green jobs:

- Download endpoint redirects to the new DMG.
- DMG mounts and the app launches on the supported macOS version.
- codesign assessment and notarization ticket pass.
- Sparkle feed reports the expected version and build.
- Landing, FAQ, privacy, and terms pages show local-first copy.
- Public pages promote only the private, local Mac experience and use generic
  model names.
- Legacy backend health remains green for older installed binaries.

## Rollback

- Web: redeploy the last known-good commit and compatible migrations.
- Mac: republish the last known-good signed artifact and appcast entry for the affected channel.
- Data-path emergency: republish the last known-good Mac artifact; existing
  Keychain tokens and the legacy backend remain available during this transition.
- Model emergency: preserve on-device speech recognition and fall back from
  guarded language-model cleanup to deterministic rules.

Do not publish a production release from an ad-hoc signed build.
