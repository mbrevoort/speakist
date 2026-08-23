# CI and CD

Speakist ships a Cloudflare web application and a notarized Mac application.

## Workflows

### Development

.github/workflows/deploy-dev.yml runs on pushes to main and on manual dispatch.

- changes: identifies whether web or Mac inputs changed.
- web: installs pnpm dependencies, runs tests and type checking, applies development D1 migrations, builds, and deploys the development Worker.
- mac: regenerates the Xcode project, builds and signs the development channel, notarizes the DMG, signs the Sparkle update, uploads it, and publishes the development feed entry.

The web and Mac jobs are independent after change detection.

### Production

.github/workflows/deploy-prod.yml runs when a GitHub Release is published or manually replayed for an existing tag.

- context: validates the semantic version and resolves stable versus beta.
- web: runs tests and type checking, applies production migrations, and deploys the production Worker.
- mac: builds the selected channel from the release tag, signs and notarizes the DMG, uploads it, and publishes the matching Sparkle feed entry.

Prereleases route to beta; ordinary releases route to stable.

## Required secrets

Web deployment:

- CLOUDFLARE_API_TOKEN
- CLOUDFLARE_ACCOUNT_ID
- release publication token and environment secrets documented in web setup

Mac delivery:

- APPLE_DEVELOPER_ID_P12_BASE64
- APPLE_DEVELOPER_ID_P12_PASSWORD
- APP_STORE_CONNECT_API_KEY_BASE64
- APP_STORE_CONNECT_KEY_ID
- APP_STORE_CONNECT_ISSUER_ID
- SPARKLE_PRIVATE_KEY
- R2 credentials used by release-ci.sh

Never commit secrets or generated authentication material.

## Configuration

- Public and non-secret Worker values live in web/wrangler.toml.
- Worker secrets are set with wrangler secret put for each environment.
- Native channel values live in project.yml and are injected by scripts/release.sh.
- project.yml is the Xcode source of truth; CI always regenerates before building.

## Local parity checks

Before pushing:

    make project
    make test

    cd web
    pnpm install --frozen-lockfile
    pnpm test
    pnpm exec tsc --noEmit
    pnpm build

When the local Developer ID identity is unavailable, ad-hoc signing is acceptable for tests. It is not release proof.

## Release proof

A green compile is insufficient. Confirm:

1. Native tests and web tests pass.
2. The Mac archive is signed with the intended identity.
3. Notarization succeeds and the ticket is stapled.
4. The DMG is uploaded at the expected channel path.
5. The Sparkle signature and appcast entry match the exact build.
6. The deployed website download endpoint resolves to that artifact.
7. A clean-install onboarding smoke test downloads models and completes local dictation.
8. An existing-install upgrade preserves its prior engine selection.
9. Switching to Cloud still requires and uses a valid account.

## Common failures

- Locked or missing Developer ID key: local test with ad-hoc signing; unlock or import the correct identity before release.
- Xcode project drift: edit project.yml and run make project.
- Missing D1 tables: run local initialization or apply the environment migrations.
- Stale download link: verify the release publication step and channel-specific R2 base URL.
- Model setup failure: verify network access for first download and that pinned model revisions still resolve.
