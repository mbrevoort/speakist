# Speakist architecture

A menu-bar-only macOS utility that captures push-to-talk audio, transcribes it via a cloud STT API, optionally cleans it up with an LLM, and pastes the result at the user's cursor in any app.

See [speakist-prd.md](speakist-prd.md) for the product spec. This doc describes how the pieces are wired together in code.

---

## 1. Tech stack

| Layer | Choice |
|---|---|
| Language | Swift 5.10 |
| UI | SwiftUI (+ AppKit bridges for menu bar, HUD, windows) |
| Min OS | macOS 14 (Sonoma) |
| Build | Xcode 15+, project generated from [`project.yml`](../project.yml) via [XcodeGen](https://github.com/yonaskolb/XcodeGen) |
| Signing | Developer ID (team `Q5T8FJNX57`), Hardened Runtime on |
| Persistence | SQLite via [GRDB.swift](https://github.com/groue/GRDB.swift) |
| Shortcuts | [sindresorhus/KeyboardShortcuts](https://github.com/sindresorhus/KeyboardShortcuts) |
| Auto-update | [Sparkle 2](https://github.com/sparkle-project/Sparkle) |
| Bundle ID | `com.brevoort-studio.speakist` |

Deliberately avoided: third-party networking (URLSession suffices), telemetry SDKs, Alamofire, Core Data.

---

## 2. High-level architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                          AppDelegate (MainActor)                      │
│    owns AppEnvironment, MenuBarController, ShortcutManager,           │
│    SettingsWindowController, HistoryWindowController, Onboarding      │
└───────────────────────────────────────────────────────────────────────┘
                                  │
                       ┌──────────┴──────────┐
                       │   AppEnvironment    │  (DI container)
                       └──────────┬──────────┘
                                  │
     ┌──────────────┬─────────────┼─────────────┬──────────────┐
     ▼              ▼             ▼             ▼              ▼
Preferences    Keychain     PermissionCoord  DeviceMonitor   Logger
HistoryStore   Correction   UsageTracker     AudioArchive    Notifier
AudioRecorder  CursorInserter FocusedField   HUDController   Updater
               TranscriptionService

       (shortcut trigger)
       ShortcutManager ──▶ AudioRecorder ──▶ TranscriptionService
                                                   │
                                                   ├─▶ DeepgramClient
                                                   ├─▶ CursorInserter (clipboard + ⌘V)
                                                   ├─▶ HistoryStore + AudioArchive
                                                   └─▶ UsageTracker + HUDController + Notifier
```

### 2.1 Threading model

- **Main actor** owns all UI, permissions, preferences, SQLite access, and the menu bar. `AppEnvironment`, `HistoryStore`, `CorrectionStore`, `Preferences`, `KeychainStore`, `PermissionCoordinator`, `HUDController`, `MenuBarController`, `AppDelegate`, and all SwiftUI views are `@MainActor`.
- **AudioRecorder** is deliberately *not* main-actor-isolated. Its mic tap closure runs on Core Audio's internal thread; `start`/`stop` are marked `@MainActor` so mutations to state always happen on main. The tap reads `self.converter` / `self.outputFile` directly — safe because we install/remove the tap synchronously before those properties change.
- **STT client** (`DeepgramClient`) is a `struct` with `Sendable` conformance, so it can be awaited from any actor without reference-capture concerns.
- **Sqlite writes** go through `DatabaseQueue.write { … }` (GRDB serializes internally).

### 2.2 Activation policy

`LSUIElement = YES` in Info.plist. `NSApp.setActivationPolicy(.accessory)` is re-applied on launch. No Dock icon, no Cmd+Tab presence. Settings / History / Onboarding are explicit `NSWindowController`s that call `NSApp.activate(ignoringOtherApps:)` before `showWindow(nil)` + `orderFrontRegardless()` — the SwiftUI `Settings { }` scene's `showSettingsWindow:` dispatch is unreliable for menu-bar-only apps, so we bypass it entirely.

---

## 3. Module layout

```
Speakist/
├── App/                 @main, AppDelegate (MainActor), DI container (AppEnvironment), Notifier
├── MenuBar/             NSStatusItem controller + programmatically-drawn brand glyph
├── Shortcut/            Wraps KeyboardShortcuts, owns push-to-talk state machine
├── Recording/           AVAudioEngine capture + device enumeration + live RMS levels
├── Transcription/       Deepgram client + orchestrator
├── Paste/               Clipboard-snapshot + synthetic ⌘V, plus AX focus probe
├── Corrections/         Word-level Myers diff → correction pairs → SQLite store → Deepgram keyterms
├── History/             SQLite-backed transcription log, FTS5 search, audio archive, UI window
├── Settings/            SettingsWindowController + SwiftUI sidebar + tab views + Keychain + Preferences
├── HUD/                 Floating borderless panel with pulsing dot + live waveform + timer
├── Onboarding/          First-run 4-pane flow (welcome, permissions, provider, launch-at-login)
├── Permissions/         Mic + Accessibility state machine with TCC polling
├── Usage/               Deepgram minute rollups + cost estimation
├── Updates/             Sparkle 2 integration
├── Logging/             os.Logger façade with rotating 5MB file sink
└── Resources/           Assets.xcassets (app icon, accent color), brand colors
```

---

## 4. Data flow: one round-trip

```
          user holds ⌃⌘X                                user releases ⌃⌘X
                │                                                │
                ▼                                                ▼
  ShortcutManager.pushDown()                    ShortcutManager.pushUp()
                │                                                │
                ▶ permission + state gates                       ▶ stop recording → RecordingResult
                ▶ beginRecording()                               ▶ min-duration check
                ▶ AudioRecorder.start()                          ▶ TranscriptionService.process(…)
                ▶ HUDController.showRecording()                          │
                ▶ max-duration timer armed                               ▼
                                                            build keyterms from CorrectionStore
                                                                         │
                                                                         ▼
                                                            DeepgramClient.transcribe() (+1 retry)
                                                                         │
                                                                         ▼
                                                            FocusedFieldProbe.probe() → AX editable?
                                                                         │
                                                                         ▼
                                                            CursorInserter.insert(text,
                                                                                   hasEditableFocus)
                                                                         │
                                                                         ▼
                                                            AudioArchive.archive(...) → history file
                                                            HistoryStore.save(TranscriptionEntry)
                                                            UsageTracker.record(...)
                                                            HUDController.hide()
                                                            NSSound.Pop playback (if enabled)
```

The one-retry-with-backoff lives in `TranscriptionService.withRetry`; `TranscriptionError.authFailure` cases never retry.

---

## 5. Persistence

Three SQLite databases in `~/Library/Application Support/Speakist/`:

| File | Managed by | Schema |
|---|---|---|
| `history.sqlite` | [`HistoryStore`](../Speakist/History/HistoryStore.swift) | `transcriptions` + FTS5 shadow `transcriptions_fts` + `usage` |
| `corrections.sqlite` | [`CorrectionStore`](../Speakist/Corrections/CorrectionStore.swift) | `corrections` (unique `(from_text, to_text)`) |

Audio files live in `~/Library/Application Support/Speakist/Audio/<uuid>.wav`, managed by `AudioArchive` with a rolling "keep last N" prune policy (N configurable; default 20).

### Retention
- History: older-than-N-days **AND** beyond-top-M-entries, whichever is stricter. Defaults: 90 days / 1000 entries, user-tunable in Settings → History.
- Audio: `keepAudio` toggle + `keepAudioCount`; purged on each new archive.
- Both databases are unencrypted; macOS FileVault handles disk-level protection. Documented in About.

### Correction learning loop

1. User edits a history row's `final_transcript`.
2. `DiffEngine.corrections(from:raw, to:edited)` runs a Myers-LCS token diff, extracts 1–4-token replacement runs, filters out pure punctuation/case-only edits.
3. Each `CorrectionPair` is ingested into the `corrections` table (upsert on `(from, to)` with incrementing `count` and `last_seen`).
4. On the next transcription, `VocabularyBuilder.keyterms(from:)` returns the top 50 *proper-noun-like* corrections (capitalized / has a digit) to feed into Deepgram's custom-vocab slot (`keyterm[]` for Nova-3, `keywords[]` for Nova-2).

---

## 6. Deepgram client

| Client | Endpoint | Retry | Custom-vocab slot |
|---|---|---|---|
| [`DeepgramClient`](../Speakist/Transcription/DeepgramClient.swift) | `POST /v1/listen` | 1× @ 500ms | `keyterm[]` (Nova-3) or `keywords[]` (Nova-2) |

The client owns no state beyond its API key + model selection — it's a `Sendable` struct constructed per-request. Errors map into a unified `TranscriptionError` enum (`.authFailed`, `.rateLimited`, `.serverError(Int, String?)`, `.network(String)`, etc.). `TranscriptionService` handles them centrally — `.authFailure` surfaces a user-visible notification, transient failures write a `transcription_status = "failed"` history row that the user can re-run from the History window.

---

## 7. Paste pipeline

[`CursorInserter`](../Speakist/Paste/CursorInserter.swift) does the clipboard + synthetic ⌘V dance:

1. Snapshot current pasteboard (all types, all items) + `changeCount`.
2. Clear + write transcript as plain string.
3. Post synthetic ⌘V via `CGEvent` on `.cghidEventTap` if the focused field is editable.
4. Sleep ~120ms for the target app to consume the paste.
5. Restore the snapshot only if `changeCount` is still `snapshot + 1` (no one else wrote during the window).

[`FocusedFieldProbe`](../Speakist/Paste/FocusedFieldProbe.swift) uses AX APIs (`AXUIElementCreateSystemWide` + `kAXFocusedUIElementAttribute`) to decide whether to fire the synthetic keystroke at all. Roles checked: `kAXTextFieldRole`, `kAXTextAreaRole`, `kAXComboBoxRole`, secure-text subroles, and any element exposing a settable string `AXValue` or a `kAXSelectedTextAttribute`.

Fallback: if the focused element isn't editable, we **don't** restore the old clipboard — we leave the transcript on the pasteboard and post a "Copied to clipboard" notification so the user can `⌘V` manually.

---

## 8. Permissions

Speakist needs two OS-level grants:

| Grant | How requested | Consequence if denied |
|---|---|---|
| Microphone | `AVCaptureDevice.requestAccess(for: .audio)` — requires `com.apple.security.device.audio-input` entitlement with Hardened Runtime enabled | Recording fires no audio; `requestAccess` silently returns `false` |
| Accessibility | `AXIsProcessTrustedWithOptions([...AXTrustedCheckOptionPrompt: true])` — no entitlement required | Synthetic ⌘V can't fire; transcripts go to clipboard only |

[`PermissionCoordinator`](../Speakist/Permissions/PermissionCoordinator.swift) polls both states every second on `.common` run-loop mode (so SwiftUI event tracking doesn't starve the timer) AND refreshes on `NSApplication.didBecomeActive` / `NSWorkspace.didActivateApplicationNotification` — the latter catches the common case where the user flips a switch in System Settings and returns to Speakist.

Both grants are TCC-keyed on the signed binary hash. Ad-hoc rebuilds change that hash each build and invalidate the grant; Developer ID signing keeps it stable.

---

## 9. UI surfaces

### 9.1 Menu bar ([`MenuBarController`](../Speakist/MenuBar/MenuBarController.swift))

- `NSStatusItem` with variable length, icon-only.
- Custom glyph drawn programmatically in [`MenuBarIcon`](../Speakist/MenuBar/MenuBarIcon.swift) — a rounded speech bubble with a 5-bar waveform cut out via even-odd path winding. Color is **baked into the NSImage** per state (idle = black template, recording = peach, transcribing = mustard, paused = 45% alpha template) because `NSStatusBarButton.contentTintColor` is inconsistent.
- Menu attached directly (`statusItem.menu = menu`) with `NSMenuDelegate.menuNeedsUpdate(_:)` rebuilding items on each open, so the status line, "Recent" submenu, and Pause/Resume label always reflect current state.
- Alpha pulse animation (30fps sine) for recording / transcribing states.

### 9.2 HUD overlay ([`HUDController`](../Speakist/HUD/HUDController.swift))

- Floating `NSPanel` (`.borderless + .nonactivatingPanel`, level `.statusBar`).
- Positioned ~28pt above the cursor; snaps to screen edges.
- Live waveform: 12-bar ring buffer fed by `AudioRecorder.levels` PassthroughSubject at buffer rate (~64ms @ 16kHz / 1024 samples).
- RMS level is `sqrt`-curved (`sqrt(min(rms*4, 1))`) so normal speech visibly fills ~60–80% of bar height instead of ~10%.
- Ignores mouse events so it never steals focus.

### 9.3 Settings ([`SettingsWindowController`](../Speakist/Settings/SettingsWindowController.swift) + [`SettingsWindow`](../Speakist/Settings/SettingsWindow.swift))

Sidebar layout using `NavigationSplitView`. Eight sections: General, Shortcuts, Audio, Transcription, Vocabulary, History, Usage, About. Minimum window size 720×520; sidebar fixed between 200–260pt.

The Deepgram key lives in the Keychain (service `com.brevoort-studio.speakist.apikeys`, account `deepgram`). All other preferences live in `UserDefaults` via [`Preferences`](../Speakist/Settings/Preferences.swift), an `ObservableObject` wrapper.

### 9.4 History window ([`HistoryWindow`](../Speakist/History/HistoryWindow.swift))

Two-pane split view: searchable/filterable list on the left, per-entry detail on the right. Detail has raw transcript (read-only), editable final transcript (diffs on blur → correction pairs), audio playback if retained, and re-transcribe button.

### 9.5 Onboarding ([`OnboardingWindow`](../Speakist/Onboarding/OnboardingWindow.swift))

Four panes: Welcome → Permissions → Sign in to Speakist (device-code flow) → Launch-at-login. Uses `canAdvance` gates so the Continue button only enables when each pane's requirements are met.

---

## 10. Distribution & release

- Debug/local: ad-hoc signing disabled, Developer ID signing applied by default because `DEVELOPMENT_TEAM` is set in [`project.yml`](../project.yml).
- Release: `make archive` → Xcode `Release` configuration → `notarytool submit --wait` → `stapler staple` → DMG.
- Auto-update: Sparkle 2 appcast at `https://speakist.ai/appcast.xml` (EdDSA public key lives in Info.plist `SUPublicEDKey`).

---

## 10½. Speakist backend integration (Phase 6)

The Mac app is no longer a standalone client — it authenticates against a
companion Next.js backend that lives in [`web/`](../web/) and runs on
Cloudflare (Workers + D1 via OpenNext). Billing lives server-side; the Mac
just:

1. **Signs in** via a device-code flow. `Speakist/Account/SpeakistAccountManager`
   POSTs to `/api/device/start`, displays the returned user-code in Settings,
   opens `/link?code=…` in the browser, polls `/api/device/poll` every ~3 s.
   On "authorized" it stores a 48-hex refresh token in the Keychain
   (`KeychainAccount.refreshToken`).
2. **Mints a Deepgram key per transcription.** `TranscriptionService.buildClient()`
   POSTs to `/api/deepgram/token` (Bearer auth) and receives a short-lived
   scoped Deepgram key (TTL 10 minutes, `usage:write` only). The Mac uses
   that key for one `/v1/listen` call; the server-side key auto-deletes
   after TTL.
3. **Reports usage** via `POST /api/usage` with `{transcriptionClientId,
   wordCount, audioMs, model}`. Backend deduplicates on
   `(orgId, transcriptionClientId)` so a Mac retry with the same UUID
   debits at most once. Response includes `newBalanceMillicents` and
   `autoTopupTriggered`.
4. **(Planned)** Vocabulary sync via `GET/POST /api/vocabulary`. Server
   endpoints exist; Mac-side wiring into `CorrectionStore` is a follow-up.

### Privacy load-bearing claim

The Mac talks to Deepgram **directly**. The backend only mints the
authorization token. Your voice and transcripts never pass through
Speakist's servers. This is not a marketing line — it's a constraint on
every feature going forward.

### Failure modes the Mac translates to UX

| Backend signal | Mac behavior |
|---|---|
| `401 not signed in` | Notifier + "Session rejected — please sign in again" |
| `402 insufficient_credit` | Notifier + "Top up at {URL}/dashboard/billing" |
| Network error minting token | Retry once, then save failed history entry |

---

## 11. What's deliberately *not* in v1

- On-device / offline STT.
- Streaming / token-by-token paste.
- Per-app correction scoping (corrections are global).
- Voice commands ("new paragraph", etc.).
- Telemetry, remote crash reporting.
- Mac App Store (sandbox blocks synthetic events).

See §11 of [speakist-prd.md](speakist-prd.md) for the full out-of-scope list.
