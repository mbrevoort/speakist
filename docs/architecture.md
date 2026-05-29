# Speakist architecture

Speakist is push-to-talk dictation for Mac and iOS, backed by a small
Cloudflare Worker. The product lives in three places:

| Surface | Code | What it does |
|---|---|---|
| Mac menu-bar utility | `Speakist/` | Hold a shortcut, speak, release; transcript pastes at the cursor in any app. |
| iOS containing app | `SpeakistiOS/` | Quick Dictate (record → polish → clipboard). Holds the mic session. |
| iOS keyboard extension | `SpeakistKeyboard/` | Custom keyboard with a record button. Cannot hold the mic itself; talks to the containing app via App Group. |
| Backend | `web/` | Auth (magic-link + device-code), per-org pricing, transcribe proxy, polish, billing. Next.js → Cloudflare Workers via OpenNext, D1 for storage, R2 for DMG hosting. |
| Cross-target Swift | `Shared/` | A handful of files used by all three Apple targets — channel resolution, App Group bridge, history entry, etc. |

This doc covers how the wires are run. The [`web/README.md`](../web/README.md)
covers the design principles behind the backend; [`README.md`](../README.md)
covers the product surface.

---

## 1. Tech stack

| Layer | Choice |
|---|---|
| Apple targets | Swift 5.10, SwiftUI (+ AppKit / UIKit bridges), Xcode 16+ |
| Min OS | macOS 14 (Sonoma), iOS 17 |
| Build | XcodeGen-generated `Speakist.xcodeproj` from [`project.yml`](../project.yml) |
| Code signing | Developer ID Application for Mac DMGs; Apple Distribution for iOS App Store / TestFlight. Team ID baked into `project.yml` via the `SPEAKIST_APPLE_TEAM_ID` env var — see [`../README.md#forking-this-repo`](../README.md#forking-this-repo). |
| Mac persistence | SQLite via [GRDB.swift](https://github.com/groue/GRDB.swift) |
| Mac shortcuts | [sindresorhus/KeyboardShortcuts](https://github.com/sindresorhus/KeyboardShortcuts) |
| Mac auto-update | [Sparkle 2](https://github.com/sparkle-project/Sparkle) |
| iOS IPC | App Group shared `UserDefaults` + Darwin notifications + URL scheme deep-links |
| Backend framework | Next.js 15 (App Router) + TypeScript + Tailwind + shadcn/ui |
| Backend hosting | Cloudflare Workers via [`@opennextjs/cloudflare`](https://opennext.js.org) |
| Database | Cloudflare D1 (managed SQLite) |
| ORM | Drizzle (TypeScript-native, SQLite-friendly) |
| Auth | Auth.js v5 (NextAuth) + magic-link + Drizzle adapter |
| Email | Resend (dev falls back to console) |
| Payments | Stripe (Checkout + Customer Portal + webhooks) |
| Upstream STT | Groq Whisper (default) and DeepGram, switchable per-org by super admin |
| Polish LLM | Groq `llama-3.1-8b-instant` |
| Polish prompt store | `polish_prompt_versions` (D1) — versioned, rollback-able, edited via `/admin/polish-prompts` or proposed via the MCP `propose_polish_prompt` tool. Seed bodies in [`web/src/lib/transcription/default-polish-prompts.ts`](../web/src/lib/transcription/default-polish-prompts.ts). |

Deliberately avoided: third-party networking SDKs (`URLSession`/`fetch`
suffice), telemetry, Core Data, multiple-region hosting, RLS-style DB
policies (Cloudflare D1 doesn't have RLS — every server route goes
through `requireUser` / `requireOrgMember` / `requireSuperAdmin`).

---

## 2. The transcribe path

This is the load-bearing flow. The same shape on Mac and iOS.

```
                   ┌─────────────────────┐
   user gesture ──▶│  AudioRecorder      │       16-kHz mono Int16 WAV
                   │  (AVAudioEngine)    │       streamed to disk
                   └──────────┬──────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │  SpeakistTranscribeClient     │   POST /api/transcribe
              │  bearer = signed-in session   │   body = audio bytes
              └───────────────┬───────────────┘
                              │
                              ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Cloudflare Worker — /api/transcribe                         │
   │  1. Resolve user's active org (last_active_org_id || 1st)    │
   │  2. Read X-Language. Pick provider+model:                    │
   │       en  → groq/whisper-large-v3-turbo                      │
   │       else → groq/whisper-large-v3                           │
   │     (plus org's allowed_models_json as a guard + override)   │
   │  3. resolveProviderKey(env, orgId, providerId)               │
   │       org override → app_settings system key → env → throw   │
   │  4. dispatch() → upstream provider's REST API                │
   │  5. (optional) runPolish() — Groq llama-3.1-8b-instant       │
   │       super-admin's mode prompt; output-length sanity check  │
   │  6. debitForAudioTranscription() — credit ledger insert      │
   │  7. return { text, audioSeconds, provider, model, balance }  │
   └──────────────────────────────────────────────────────────────┘
                              │
                              ▼
                   ┌─────────────────────┐
                   │  CursorInserter     │   clipboard + synthetic ⌘V
                   │  (Mac)              │   if AX detects editable
                   └─────────────────────┘
                              │
                              ▼
                  ┌────────────────────┐
                  │ HistoryStore       │   SQLite, on-device only
                  │ AudioArchive       │   audio file, on-device only
                  └────────────────────┘
```

**Privacy claim**: audio bytes pass through the Worker en route to the
upstream provider, but the Worker streams without persisting and never
writes audio or transcript text to D1, R2, or logs. The history (raw
+ polished transcript + the .wav file) lives only on the user's
device.

### 2.1 Why a proxy and not Mac-direct

Earlier versions had the Mac POST audio to DeepGram directly using a
short-lived ephemeral key minted by the Worker. The proxy path replaced
that because:

- Provider can be swapped per-org by the super admin without a Mac
  release.
- Per-transcription cost accounting is straightforward (server sees
  the provider's reported duration; ledger insert is inline).
- Polish and credit debits happen in the same response, removing the
  separate `/api/usage` round-trip the legacy path needed.

The legacy DeepGram-direct path (`scripts/release.sh` calls it Phase A)
still exists in the Mac codebase but is gated behind `useTranscribeProxy`
which defaults to true. Plan to remove it once we're confident the
proxy has been the only path used for a release cycle.

---

## 3. Module layout (Apple)

```
Shared/                  Cross-target. SpeakistChannel, AppGroupBridge,
                         DarwinNotifier, HistoryEntry, SpeakSessionState,
                         URLSchemeBridge.

Speakist/                Mac app.
├── App/                 @main, AppDelegate (MainActor), AppEnvironment (DI),
│                        Notifier
├── Account/             SpeakistAPIClient (shared with iOS via project.yml
│                        cross-compile), SpeakistAccountManager, KeychainStore
├── MenuBar/             NSStatusItem controller + programmatically-drawn glyph
├── Shortcut/            KeyboardShortcuts wrapper, push-to-talk state machine
├── Recording/           AVAudioEngine capture + device monitor + RMS levels
├── Transcription/       SpeakistTranscribeClient (proxy path),
│                        DeepgramClient (legacy direct path),
│                        TranscriptionService (orchestrator)
├── Paste/               Clipboard snapshot + synthetic ⌘V + AX focus probe
├── Corrections/         Myers diff → CorrectionStore → keyterm boost feed
├── History/             SQLite-backed history, FTS5 search, audio archive,
│                        history window
├── Settings/            Settings window controller + sidebar tabs +
│                        Preferences (UserDefaults) + KeychainStore
├── HUD/                 Floating panel with pulsing dot + waveform + timer
├── Onboarding/          First-run flow (welcome → permissions → sign-in →
│                        polish opt-in → launch-at-login)
├── Permissions/         Mic + Accessibility state machine, TCC polling
├── Usage/               Local rollups (server is the source of truth)
├── Updates/             Sparkle 2 integration
├── Logging/             os.Logger façade with rotating 5MB file sink
└── Resources/           Assets.xcassets (app icon, accent color), brand colors

SpeakistiOS/             iOS containing app.
├── App/                 @main, RootView (Home settings list)
├── Onboarding/          First-run flow (sign-in → mic → keyboard install)
├── Session/             SpeakSessionController, ListeningOverlay,
│                        SwipeBackHint
├── QuickDictate/        Quick-dictate flow (record → polish → clipboard)
├── Recording/           AudioRecorder (iOS variant)
├── Transcription/       SpeakistTranscribeClient (iOS-minimal variant)
├── Settings/            PolishSection (inline section, not a screen)
├── History/             HistoryStore (App-Group-shared) + HistoryView

SpeakistKeyboard/        iOS custom keyboard extension.
├── KeyboardViewController.swift
└── …                    Renders the record button, opens the containing
                         app via URL scheme + Darwin notifications. Cannot
                         hold the mic session itself (iOS rule since 2014).
```

### 3.1 What gets cross-compiled

`SpeakistiOS` and `SpeakistKeyboard` reuse a handful of files from
`Speakist/` (the Mac target) — see `project.yml` `SpeakistiOS:` source
list. Today: `AppIdentity`, `Logger`, `Brand`, `SpeakistAPIClient`,
`SpeakistAccountManager`, `TranscriptionTypes`, `DiffEngine`,
`KeychainStore`. Adding a file to that list requires both targets to
compile cleanly without macOS-only imports.

CI's path filter knows about this list — see
`.github/workflows/deploy-dev.yml` — so a change to one of those
specific files retriggers both Mac and iOS builds, not just Mac.

### 3.2 Threading model (Mac)

- **Main actor** owns all UI, permissions, preferences, SQLite access,
  and the menu bar.
- **AudioRecorder** is deliberately *not* main-actor-isolated. Its mic
  tap closure runs on Core Audio's internal thread; `start`/`stop` are
  marked `@MainActor` so mutations to state always happen on main.
- **STT clients** are `Sendable` structs constructed per-request, so
  they can be awaited from any actor without reference-capture
  concerns.
- **GRDB writes** go through `DatabaseQueue.write { … }` (GRDB
  serializes internally).

### 3.3 Threading model (iOS)

Largely the same, with two iOS-specific complications:

1. The keyboard extension can't access the mic. The extension fires a
   Darwin notification + opens a URL into the containing app, which
   then takes over.
2. iOS 26 enforces a manual swipe-right gesture to return from a
   keyboard-launched main app — `SwipeBackHint` teaches the user the
   gesture once.

---

## 4. Persistence

| Store | Lives | Schema | Notes |
|---|---|---|---|
| Mac history | `~/Library/Application Support/Speakist/history.sqlite` | `transcriptions` (raw + polished + audio path) + FTS5 + `usage` rollup | Editing `final_transcript` triggers correction-pair extraction |
| Mac corrections | `~/Library/Application Support/Speakist/corrections.sqlite` | `corrections (from, to)` upserted with `count` + `last_seen` | Top 50 proper-noun-shaped entries fed to STT keyterms (when supported) |
| Mac audio archive | `~/Library/Application Support/Speakist/Audio/<uuid>.wav` | rolling "keep last N" prune | N is user-tunable; default 20 |
| iOS history | App-Group shared `UserDefaults` + audio in App Group container | `HistoryEntry` struct list (no SQLite — small N, simple list works) | Shared with the keyboard extension so both surfaces see the same recent dictations |
| Backend | Cloudflare D1 | `users`, `organizations`, `org_members`, `invitations`, `sessions`, `mac_sessions`, `device_auth_codes`, `usage_events`, `credit_ledger`, `pricing_config`, `provider_pricing`, `releases`, `app_settings`, `vocabulary_entries` | See `web/drizzle/migrations/` for the full schema timeline |

### 4.1 Correction-learning loop

1. User edits a Mac history row's `final_transcript`.
2. `DiffEngine.corrections(from:raw, to:edited)` runs a Myers token
   diff and extracts 1–4-token replacement runs.
3. Each pair is upserted into `corrections.sqlite`.
4. On the next transcription, `VocabularyBuilder.keyterms(from:)`
   returns the top 50 proper-noun-shaped corrections to feed the
   transcription engine's keyterm-boost slot if the chosen provider
   supports one (DeepGram does; Groq Whisper doesn't, so keyterms
   are silently dropped on Whisper).

iOS doesn't have a correction loop today — the iOS history surface is
read-only.

---

## 5. Auth

Two flows, share the same backing tables.

### 5.1 Web magic-link

Standard Auth.js: enter email → email arrives → click link → session
cookie. Used for `/dashboard` access on the web.

### 5.2 Device-code (Mac + iOS)

```
1. Mac/iOS app   POST /api/auth/device/start                → user_code, device_code
2. Mac/iOS app   open https://<base>/link?code=<user_code>  in browser
3. User signs in on web with magic link if not already
4. /link page    confirms the code; if user has 2+ org memberships,
                 picks one explicitly here (writes users.last_active_org_id)
5. Mac/iOS app   POST /api/auth/device/poll every ~3s  → refresh token
                 (stored in Keychain on Mac, in iOS Keychain via App Group)
```

The /link page's workspace picker is the **only** UI for choosing a
workspace on Mac/iOS. To switch workspaces on a device, sign out and
sign back in. Web has a topbar dropdown for switching in-place.

### 5.3 Multi-org

A user can belong to multiple `organizations` via `org_members` rows.
`getCurrentOrgForUser` resolves to `users.last_active_org_id` if it's
still a valid membership; otherwise to the earliest-joined membership
and self-heals the column. `acceptInvitation` auto-sets the persisted
choice to the just-joined org so the post-redirect dashboard lands in
the new workspace, not a stale earlier one.

---

## 6. Polish

A second LLM pass that runs after STT. Two server-side modes:

- **Intuitive** — applies explicit self-corrections ("I mean…",
  "scratch that…"), fixes obvious slips. The intent-aware variant.
- **Prescriptive** — punctuation, capitalization, clear grammar
  fixes only. Never touches meaning. Default for new users.

Each user picks `polish_mode` per their `users` row (UI on Mac
Settings → Polish, iOS Home → Polish, web `/dashboard/settings`).
The active prompt strings live in `polish_prompt_versions` (D1),
versioned + rollback-able, edited at `/admin/polish-prompts` or
proposed via the MCP `propose_polish_prompt` tool. The resolver
falls through three tiers: versions table → deprecated
`app_settings.polish_*_prompt` (kept one release for safety) →
baked-in baseline in
[`default-polish-prompts.ts`](../web/src/lib/transcription/default-polish-prompts.ts).
The active learning loop driving prompt iteration is documented in
[feedback-agent.md](feedback-agent.md).

`runPolish` has two defensive backstops:

1. If output length > 2× input length → reject (model went rogue).
2. If output starts with a banned assistant preamble ("Sure,",
   "Here is", "Of course", "I'd be happy to", etc.) → reject.

On rejection the raw transcript is returned and `errorReason` is
logged. Same for any HTTP/network failure — polish is best-effort and
must never block the user from getting their transcript.

---

## 7. Per-org provider routing

`organizations.allowed_models_json` is a per-org whitelist of
`provider/model` slugs. Behaviour in `lib/transcription/orgAccess.ts`:

- NULL or empty → use the language-based default (`groq/whisper-
  large-v3-turbo` for English, `groq/whisper-large-v3` otherwise).
- Non-empty and the language default is in the list → use the
  language default.
- Non-empty and the language default is NOT in the list → use the
  first allowed entry.

Pinning an org to e.g. `["deepgram/nova-3"]` is how a super admin
gives one org a different STT engine without changing global defaults.

API key resolution (`lib/transcription/secrets.ts`) is in this order:

1. Org override (`organizations.<provider>_key_override_encrypted`)
2. System key (`app_settings.system_<provider>_key_encrypted`)
3. `<PROVIDER>_API_KEY` env (Worker secret or `.env.local`)
4. Throw `no_key_configured`

All system + org-override keys are AES-GCM-encrypted at rest with
`APP_ENCRYPTION_KEY` (set as a Worker secret).

---

## 8. Permissions

| Grant | How requested | Consequence if denied |
|---|---|---|
| Microphone (Mac) | `AVCaptureDevice.requestAccess(for: .audio)` — needs `com.apple.security.device.audio-input` entitlement + Hardened Runtime | Recording fires no audio; `requestAccess` silently returns false |
| Accessibility (Mac) | `AXIsProcessTrustedWithOptions` | Synthetic ⌘V can't fire; transcripts go to clipboard only |
| Microphone (iOS) | `NSMicrophoneUsageDescription` in Info.plist | Recording fails |
| Keyboard Full Access (iOS) | User toggles in Settings → General → Keyboard | Keyboard extension can't reach the App Group, can't open the containing app via URL |
| Local Network (iOS) | `NSLocalNetworkUsageDescription` | Tailscale-routed dev backend (CGNAT IPs) is unreachable; production speakist.ai is fine |

`PermissionCoordinator` (Mac) polls TCC state every second on
`.common` run-loop mode and refreshes on `NSApplication.didBecomeActive`
and `NSWorkspace.didActivateApplicationNotification` — the latter
catches the user flipping a switch in System Settings and returning to
Speakist.

---

## 9. Distribution

| Channel | Bundle ID | Display | SUFeedURL | apiBaseURL | DMG / TestFlight |
|---|---|---|---|---|---|
| Mac stable | `com.brevoort-studio.speakist` | Speakist | `speakist.ai/appcast.xml` | `speakist.ai` | R2 → `downloads.speakist.ai` |
| Mac beta | `com.brevoort-studio.speakist.beta` | Speakist Beta | `speakist.ai/appcast-beta.xml` | `speakist.ai` | Same R2 |
| Mac dev | `com.brevoort-studio.speakist.dev` | Speakist Dev | `speakist-dev.brevoortstudio.com/appcast-dev.xml` | `speakist-dev.brevoortstudio.com` | R2 → `downloads-dev.brevoortstudio.com` |
| Mac local | `com.brevoort-studio.speakist.local` | Speakist Local | (none) | `localhost:3000` | Xcode Debug only |
| iOS stable | `com.brevoort-studio.speakist.ios` | Speakist | (n/a) | `speakist.ai` | TestFlight on the "Speakist" record |
| iOS dev | `com.brevoort-studio.speakist.ios.dev` | Speakist Dev | (n/a) | `speakist-dev.brevoortstudio.com` | TestFlight Internal on "Speakist Dev" |
| iOS local | `com.brevoort-studio.speakist.ios.local` | Speakist Local | (none) | (configurable, defaults to `speakist-dev`) | Xcode Debug only |

Every value above is **Tier 4** in the config model — baked into the
app at build time, never read at runtime over the network. Source:
`project.yml` for stable + iOS dev (first-class Xcode configurations)
plus `scripts/release.sh`'s channel matrix for Mac beta / dev (which
sed-rewrites the `Release` block before `xcodegen generate`). Runtime
code reads via `Bundle.main.infoDictionary` → the
`SpeakistChannel.current` accessors in `Shared/SpeakistChannel.swift`.
Full tier model: [cicd.md § Config management](cicd.md#config-management).

Both pipelines are automated:

* **Dev** (Mac DMG + iOS TestFlight Internal on the dev record) ships
  on every push to `main` via [`deploy-dev.yml`](../.github/workflows/deploy-dev.yml).
* **Stable + beta** ship on **GitHub Release publish** via
  [`deploy-prod.yml`](../.github/workflows/deploy-prod.yml). The
  release's prerelease checkbox routes to the `beta` channel; final
  releases route to `stable`. iOS is skipped on `beta` (no
  `…ios.beta` bundle is provisioned by design — External TestFlight
  on the stable record covers that role).

Both workflows call the same `scripts/release.sh` entry point as
manual `make release`, so the runbook in
[`docs/releasing.md`](releasing.md) describes what every release
does end-to-end. Manual `make release` remains the emergency fallback
when CI is unavailable.

---

## 10. What's deliberately not here

- On-device / offline STT. (Whisper.cpp would be the obvious add but
  changes the privacy story significantly.)
- Streaming / token-by-token paste. The ⌘V dance only works post-hoc.
- Per-app correction scoping. Corrections are global.
- Voice commands ("new paragraph", etc.). Whisper's prompt-based
  steering can do this for some use cases but isn't worth the
  complexity at this stage.
- Telemetry, remote crash reporting. By design.
- Mac App Store. Sandbox blocks the synthetic ⌘V CGEvent.
- Windows / Linux / Android.

