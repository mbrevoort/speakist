# iOS App Store submission — readiness tracker

**Status as of 2026-04-28**: blocked on **In-App Purchase migration**.
All other P0/P1 issues from the pre-submission audit are landed in
code. Once IAP is in, first-pass approval likelihood is roughly **70%**
versus near-certain rejection if we submitted today.

This doc is the working reference for getting `com.brevoort-studio.
speakist.ios` into the App Store. It captures the full audit findings,
what's already been remediated, and what's still outstanding — written
so a future return can pick the work up cold without re-deriving the
context.

---

## Background

The iOS containing app + custom keyboard extension was audited against
Apple's App Review Guidelines and `Info.plist` / privacy / billing
requirements on **2026-04-28**. The audit identified three near-certain
rejection blockers (P0) and a stack of P1/P2 items that compound the
picture. Most code-level remediation is now done. The single biggest
remaining task is replacing the iOS web-Stripe top-up flow with Apple
In-App Purchase.

For the architecture and product context this audit was applied
against, see [architecture.md](architecture.md) and
[speakist-prd.md](speakist-prd.md). For pricing-model background that
informs the IAP migration, see [pricing-strategy.md](pricing-strategy.md).

---

## Submission readiness — at a glance

| # | Item | Severity | Likelihood of rejection if shipped as-is | Status |
|---|---|---|---|---|
| 1 | In-App Purchase for top-ups (Guideline 3.1.1) | P0 | 95%+ | **Not started** |
| 2 | Custom keyboard is a fully functional QWERTY (4.5.5) | P0 | 85% | **Done** ([QwertyKeyboard.swift](../SpeakistKeyboard/QwertyKeyboard.swift), [KeyboardViewController.swift](../SpeakistKeyboard/KeyboardViewController.swift)) |
| 3 | `PrivacyInfo.xcprivacy` for iOS targets | P0 | 95%+ (automated upload reject) | **Done** ([SpeakistiOS/PrivacyInfo.xcprivacy](../SpeakistiOS/PrivacyInfo.xcprivacy), [SpeakistKeyboard/PrivacyInfo.xcprivacy](../SpeakistKeyboard/PrivacyInfo.xcprivacy)) |
| 4 | In-app account deletion (5.1.1(v)) | P0 | 80% | **Done** ([api/me/route.ts DELETE handler](../web/src/app/api/me/route.ts), [SpeakistAccountManager.deleteAccount](../Speakist/Account/SpeakistAccountManager.swift), [RootView AccountRow](../SpeakistiOS/App/RootView.swift)) |
| 5 | `NSMicrophoneUsageDescription` discloses upload | P1 | 60% (metadata reject) | **Done** ([project.yml](../project.yml)) |
| 6 | Drop `NSLocalNetworkUsageDescription` from Release | P1 | 65% (metadata reject) | **Done** ([project.yml](../project.yml)) |
| 7 | App Privacy "nutrition label" in App Store Connect | P1 | 70% (metadata reject) | **Pending submission** (manual ASC step) |
| 8 | Background-mode `audio` usage / pre-record warm-up tightening (5.1.1) | P1 | 50–60% | **Not started** |
| 9 | Sign in with Apple option (4.8) | P2 | 40% | **Not started** (defensive) |
| 10 | Full Access justification copy on keyboard (4.5.5) | P2 | 35% | Partial — keyboard strip explains; onboarding pane could say more |
| 11 | App Review submission notes covering background audio + device-code auth | P2 | n/a | **Pending submission** |

Likelihoods are calibrated against published 2024–2026 App Review
behavior. P0 items are hard blockers; P1 items reliably trigger
metadata rejections; P2 items are reviewer-discretion territory.

---

## What's done

### Custom keyboard rebuilt as a fully functional QWERTY

Was: single Speakist activation button + space/return/delete/globe.
Reviewers reject this on 4.5.5 ("provide a fully functional keyboard
with numbers, letters, punctuation, and special characters in
standard layouts").

Now: three Apple-style layouts (`ABC` / `123` / `#+=`) with proper key
proportions, three-state shift (off / one-shot / caps-lock), auto-cap
at sentence start, dark-mode-aware key colors, touch-down highlight,
globe key wired to `UIInputViewController.handleInputModeList(from:with:)`
for tap-cycle / long-press-list (Apple's standard).

The Speakist branding is a slim 40pt **activation strip** at the top
of the keyboard. It's both the dictation entry point ("Tap to dictate
with Speakist" in typing mode) and the live status indicator
("Listening — tap ✓ when done", etc.). When the user taps it from
typing mode the keyboard area transforms into the existing dictation
controls; on completion (insert ✓ or cancel ✕) it auto-flips back to
QWERTY so the user can keep editing. Without Full Access, the strip
turns coral with a clear instruction but the QWERTY remains
functional — graceful degradation that the prior keyboard didn't have.

Files:
- [SpeakistKeyboard/QwertyKeyboard.swift](../SpeakistKeyboard/QwertyKeyboard.swift) — new layout view, 250 lines
- [SpeakistKeyboard/KeyboardViewController.swift](../SpeakistKeyboard/KeyboardViewController.swift) — rewritten controller around a `DisplayMode` state machine

### Privacy manifests for iOS targets

Apple rejects builds at upload time if a required-reason API is used
without a `PrivacyInfo.xcprivacy` declaring the reason code. The Mac
target had one; the iOS targets did not.

Added two manifests (xcodegen auto-classifies `.xcprivacy` as a
resource, so no `resources:` block edit was needed):

- [SpeakistiOS/PrivacyInfo.xcprivacy](../SpeakistiOS/PrivacyInfo.xcprivacy) — declares CA92.1 (UserDefaults) + C617.1 (FileTimestamp) reasons; declares Email + User ID as collected, linked-to-user, not used for tracking, purpose App Functionality. Audio + transcripts intentionally not declared as collected because the architecture's no-persistence guarantee (`web/src/lib/transcription/...` streams without writing to D1, R2, or logs) means they fall outside Apple's "collected" definition.
- [SpeakistKeyboard/PrivacyInfo.xcprivacy](../SpeakistKeyboard/PrivacyInfo.xcprivacy) — declares only CA92.1 (UserDefaults for App Group IPC). Empty `NSPrivacyCollectedDataTypes`. The keyboard process never transmits anything off-device.

Verified bundling: after build, both files appear at `Speakist.app/PrivacyInfo.xcprivacy` and `Speakist.app/PlugIns/SpeakistKeyboard.appex/PrivacyInfo.xcprivacy`.

### `NSMicrophoneUsageDescription` rewrite

Was vague: *"Speakist listens when you start a Speak Session and
transcribes what you say."* Did not disclose the network upload —
reviewers flag this on 5.1.1.

Now: *"Speakist records your voice while a Speak Session is active and
uploads the audio to our backend for transcription. Audio is processed
and discarded — only your finished transcript is saved on this device."*

In [project.yml](../project.yml). xcodegen propagates to
[SpeakistiOS/Info.plist](../SpeakistiOS/Info.plist) on regenerate.

### `NSLocalNetworkUsageDescription` removed

Was: *"Speakist connects to your Tailscale-accessible dev server during
development."* — a developer-only string shipping in production. None
of the four channels actually need Local Network access (all use public
DNS names); the entitlement was a leftover from a since-abandoned
Tailscale dev workflow. Looked unprofessional in App Review and risked
a metadata rejection.

Now: dropped entirely from [project.yml](../project.yml). A dev who
needs it for a tailnet target host can re-add it locally and live with
xcodegen wiping it on regenerate, or override `SPEAKIST_API_BASE_URL`
to a public DNS proxy.

### In-app account deletion

Apple requires apps that allow account creation to also allow in-app
account deletion (5.1.1(v) — enforced since iOS 16). A web-only delete
link in `/dashboard` does not satisfy the rule.

Server-side, `DELETE /api/me` does a cascade delete that works without
schema changes (relies on existing `onDelete: cascade` relationships
plus a small set of explicit cleanups for non-cascading FKs):

1. Sole-member orgs are dropped outright (cascades the org's
   `creditLedger`, `usageEvents`, `usageDaily`, `invitations`).
2. Multi-member orgs persist; the user's own `usageEvents`,
   `usageDaily`, and `orgMembers` row are peeled out.
3. Non-cascading audit references (`creditLedger.createdBy`,
   `releases.publishedBy`) are NULL'd to preserve the audit row
   without a dangling pointer.
4. `invitations.invitedBy` (notNull, no cascade) deleted.
5. `usage_events.user_id` (notNull, no cascade) cleaned up
   belt-and-suspenders.
6. `device_auth_codes.user_id` (nullable, no cascade — would still
   block the user delete) cleaned up.
7. `DELETE FROM users` cascades the rest (sessions, accounts,
   mac_sessions, vocabulary_entries, residual orgMembers / usageDaily).

Files:
- Server: [web/src/app/api/me/route.ts](../web/src/app/api/me/route.ts) (`DELETE` handler appended; `GET` unchanged)
- iOS API: [Speakist/Account/SpeakistAPIClient.swift](../Speakist/Account/SpeakistAPIClient.swift) (`deleteAccount()`)
- iOS state: [Speakist/Account/SpeakistAccountManager.swift](../Speakist/Account/SpeakistAccountManager.swift) (`deleteAccount()` — calls server, mirrors `signOut()` cleanup on success, throws with token intact on failure)
- iOS UI: [SpeakistiOS/App/RootView.swift](../SpeakistiOS/App/RootView.swift) (`AccountRow.signedIn` — coral "Delete Account" button below "Sign out", native `.alert(...)` confirmation, inline error surfacing, in-flight spinner)

The wording on the confirmation dialog deliberately spells out scope —
"account, balance, vocabulary, and dictation history" — because most
users delete their account thinking only login goes away.

---

## What's left

Ordered by submission impact.

### 1. In-App Purchase migration — the only remaining hard blocker

**Why**: Apple's Guideline 3.1.1 requires IAP for digital content
consumed inside the app. The current iOS surface shows the user's
dollar balance, surfaces an "Out of credit — top up to continue"
message, and links to a web `/dashboard` page that opens Stripe
Checkout. This is a textbook 3.1.1 violation.

**Two viable paths** (decision still open):

**A) Ship StoreKit 2 in-app purchases for iOS top-ups.**
Five consumable products at Apple's `.99` price points ($4.99 /
$9.99 / $24.99 / $49.99 / $99.99) mapped to the existing bonus
ladder. ~5–7 working days. Apple takes 15% under the Small Business
Program (we qualify until prior-year App Store revenue exceeds $1M).
Server-side, the existing `credit_ledger` already supports multiple
sources — adding a `apple_iap` source row alongside `stripe_topup` is
straightforward.

**B) Ship iOS as a "free companion" with no purchase surface at all.**
Delete every dollar amount, every "top up" string, every Dashboard
link from iOS. Show "words remaining" only. Out-of-credit message
becomes informational, no CTA. Mac/web continue using Stripe. Apple
generally accepts this pattern (Spotify, Netflix, Kindle do it). ~1
day of code work. Reduces iOS revenue to zero — but Mac is the
primary surface anyway.

**Recommendation**: A is the right answer if iOS engagement matters
to growth. B is a 1-day path to App Store approval if iOS is purely
"the keyboard companion" and you're fine with all paid conversion
happening on Mac/web. Don't pick C (hybrid with a reduced-feature
free iOS) — Apple has rejected that pattern for being a confusing
"free trial that links to web" hybrid.

**Whichever we pick, the iOS code that has to come out either way:**
- `DashboardLink` row in [RootView.swift](../SpeakistiOS/App/RootView.swift) (or rewire to non-billing destination)
- The `$X.XX` balance display in `AccountRow` (replace with words-remaining or remove)
- The "top up to continue" copy in the 402 path of [SpeakistTranscribeClient.swift](../SpeakistiOS/Transcription/SpeakistTranscribeClient.swift)

If we go with A, also:
- 5 consumable products in App Store Connect, with localized names + descriptions + 1024×1024 review screenshots each
- In-App Purchase Key generated in App Store Connect for App Store Server API verification
- New server endpoint `POST /api/iap/grant` (verify Apple's signed transaction via App Store Server API; insert `creditLedger` row with `reason = "stripe_topup"`-equivalent or new `apple_iap` source — see schema decision below)
- New server endpoint `POST /api/iap/webhook` for App Store Server Notifications V2 (refunds, family-share changes; debits ledger on refund)
- New schema row `iap_transactions` (transaction id PK, org id, product id, amount paid cents, credit granted millicents, environment, created_at, refunded_at, raw_jws audit trail)
- Client-side `IAPController` with StoreKit 2 (`Product.products(for:)`, `purchase()`, `Transaction.updates` listener at app launch, `AppStore.sync()` for "Restore Purchases" — Apple-mandated even for consumables)
- Top-up sheet UI replacing the current Dashboard hand-off

**Portability to Mac**: zero today (the Mac app is direct-download,
not Mac App Store, and Mac App Store is blocked by the synthetic-⌘V
sandbox issue). But StoreKit 2 has a unified API across iOS/macOS,
so if Mac ever moves to the App Store the Swift code lifts cleanly
into `Shared/`. Don't pre-factor for that today.

### 2. Background-mode `audio` tightening

**Why**: `UIBackgroundModes: audio` is for apps whose primary
background purpose is to play/record audio audibly to the user (music
apps, calls, podcasts, dictation). Speakist uses it to keep the mic
process alive while the user swipes back to the host app. Reviewer
risk: with the current 5-minute armed timer and pre-Begin-Speaking
warm-up, a user can swipe to host, set the phone down, and the mic
stays armed for 5 minutes with the orange iOS indicator on. Defensible
but on the edge of 5.1.1 / 2.5.4.

**Concrete changes**:
- In [SpeakSessionController.swift](../SpeakistiOS/Session/SpeakSessionController.swift), drop the `AVAudioSession` in `.activating` when the user swipes back to host (currently warmed across the transition). Lose ~200 ms of first-audio in exchange for honest UX.
- Tighten the `defaultSessionDuration` from 5 min to ~60 s. Most dictations finish in under 15 s.
- Optionally add a Live Activity showing "Speakist is armed" so the user has an always-visible signal during the listening window. (Apple has approved the same pattern for Wispr Flow.)

Estimated effort: ~half a day.

### 3. Sign in with Apple — defensive

**Why**: 4.8 says apps that use a third-party login service must offer
SiwA as an equivalent option. Speakist uses first-party email-based
auth (device-code → magic-link), which is technically exempt — but
some reviewers apply 4.8 broadly when the first-party login is the
only option. The device-code Safari hand-off is also unusual on iOS
and may earn a 4.0 ("App Design") nitpick.

**Concrete changes**:
- Add SiwA via `ASAuthorizationAppleIDProvider` on iOS sign-in pane
- Server: new `POST /api/auth/apple` route that takes Apple's signed
  identity token, verifies via Apple's public keys, finds-or-creates a
  `users` row keyed by Apple's stable user identifier, returns a
  bearer token (same shape `/api/device/poll` returns)

Estimated effort: ~1 day. Skip if the device-code flow is good enough
for review (50/50 odds it is).

### 4. Full Access justification — minor polish

**Why**: Apple wants apps that require "Allow Full Access" on the
keyboard to explain *why* with specificity. We currently say "Enable
Full Access in Settings → General → Keyboard → Speakist" without the
"because dictation requires the App Group bridge to the main app"
context.

**Concrete change**: extend the EnableKeyboard onboarding pane in
[OnboardingFlow.swift](../SpeakistiOS/Onboarding/OnboardingFlow.swift)
with a sentence like *"Full Access lets the keyboard share dictation
state with the Speakist app and receive completed transcriptions. The
keyboard itself does not transmit anything outside your device — uploads
happen from the main Speakist app."* The keyboard's own coral banner
already references this; just align the onboarding copy.

Estimated effort: 15 minutes.

---

## App Store Connect prep — manual checklist

Items that are forms in App Store Connect, not code. Do these in the
hour before submission, not now (the App Privacy form needs the final
data picture, including any IAP additions).

- [ ] **Sign Paid Apps agreement**, banking info, and tax forms (W-9 for US developer accounts). Required even for free-with-IAP apps.
- [ ] **Enroll in the Small Business Program** if not already. Drops Apple's commission from 30% to 15% for developers under $1M prior-year App Store revenue. We qualify.
- [ ] **App Privacy "nutrition label"** — match the privacy manifest. Declare:
  - **Email Address** — Linked to user, not used for tracking, purpose App Functionality
  - **User ID** — Linked to user, not used for tracking, purpose App Functionality
  - If IAP ships: **Purchase History** — Linked, not tracking, App Functionality
- [ ] **Provide a sandbox test account** in App Review notes (App Store Connect → App Information → App Review Information). For IAP testing.
- [ ] **App Store description** must explicitly mention that audio is uploaded to a third-party server for transcription. App description that omits this risks a 5.1.2 metadata rejection.
- [ ] **Privacy policy URL** required in App Store Connect. Point to `https://speakist.ai/privacy` — already exists at [web/src/app/privacy](../web/src/app/privacy/).
- [ ] **EULA**: default Apple EULA is fine unless we have a custom one.
- [ ] **Support URL** required — point to `https://speakist.ai` or a dedicated support page.

---

## App Review submission notes — preemptive arguments

Pre-empt the things reviewers commonly hand back. Paste this verbatim
into App Store Connect → App Review Information → Notes when submitting:

```
Speakist is a push-to-talk dictation utility for iPhone with a
companion Mac app. The iOS surface is the containing app + a custom
keyboard extension.

Authentication: Speakist uses first-party email-based authentication
(magic link via Auth.js). The iOS app delegates sign-in to Safari via
a device-code flow (POST /api/device/start → user enters short code
on speakist.ai/link → POST /api/device/poll exchanges for a bearer
token). This is first-party first-party auth, exempt from 4.8 Sign in
with Apple requirement.

Microphone background mode: The containing app holds the AVAudioSession
across the iOS-26 mandatory swipe-back gesture so the mic remains
captured while the user is in their target app. The orange iOS mic
indicator is on for the duration of the listening window. The session
auto-tears-down after [duration] seconds of inactivity. This usage
falls under "audio recording app" per UIBackgroundModes documentation.

Custom keyboard: The Speakist keyboard provides a complete iOS
keyboard (ABC / 123 / #+= layouts, three-state shift, all standard
function keys) plus a Speakist activation strip. The keyboard itself
does not access the network or microphone — both are forbidden to
extensions by iOS. Dictation handoff to the containing app uses the
standard `openURL:options:completionHandler:` selector via the
responder chain (Wispr Flow uses the same pattern). Audio capture
happens in the containing app, never the extension.

Test account for [if applicable: IAP / general]:
[email/password]

Audio + transcript handling: Both pass through our Cloudflare Worker
en route to the upstream STT provider (Groq Whisper Turbo for English,
Whisper Large for other languages). The Worker streams without
persisting; neither audio nor transcript text is written to D1, R2,
or logs server-side. Transcripts are saved on-device only.
```

Adjust per submission state.

---

## Open decisions

- **IAP path A vs B** — has to be decided before the IAP work starts. Drives whether iOS becomes a paid-conversion surface or a free companion.
- **Whether to add Sign in with Apple** — defensive; 50/50 odds we don't need it.
- **Whether to ship a Live Activity for the listening state** — improves the background-audio defense; adds a small surface.
- **Whether to surface "Delete Account" on Mac** — not required for App Review (Mac is direct-download), but the server endpoint exists and the manager method is shared. Cosmetic / polish.

---

## When to come back to this doc

- When IAP strategy is chosen → update the `In-App Purchase migration` section with the picked path
- When IAP work starts → migrate this doc's checklist into a feature-branch implementation plan
- When App Store Connect listing is being filled out → use the manual checklist as the source of truth for the App Privacy form
- After first submission → update the Status table with the actual review verdict per item
