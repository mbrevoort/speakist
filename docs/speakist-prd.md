# Speakist — Product Requirements Document

> Push-to-talk dictation for macOS. Hold a shortcut, speak, release → transcribed text appears at your cursor in any app.

---

## 1. Context

Dictation on macOS is either heavyweight (full-featured suites like MacWhisper, Wispr Flow), bound to specific apps, or locked to Apple's built-in dictation (which is slow to activate and middling in quality). Speakist is a focused, single-purpose utility: **hold a key, talk, release, get clean text at your cursor**. It leverages Deepgram's Nova transcription models and quietly learns from the user's corrections so recurring errors (names, jargon) stop happening.

**Intended outcome**: a background Mac utility that "just works" in any text field in any app, and gets better the more it's used without any explicit training step.

---

## 2. Goals & Non-Goals

### Goals (v1)
- Push-to-talk transcription that inserts text at the current cursor in any macOS app.
- Menu-bar-only app (no Dock icon, not in Cmd+Tab).
- Deepgram STT (Nova-3 default; Nova-2 optional).
- Searchable, editable transcription history kept in SQLite.
- Correction-learning loop: edits in history feed back into future transcriptions via Deepgram custom-vocab keyterms.
- First-class brand: warm, playful peach/coral identity with a speech-bubble-meets-waveform mark.

### Non-Goals (v1)
- On-device / offline transcription.
- Streaming / token-by-token paste (batch only).
- LLM cleanup / post-processing pass.
- Multiple STT providers (Deepgram only).
- Mac App Store distribution (sandbox blocks required APIs).
- Windows / Linux / iOS support.
- Per-app correction scoping (corrections are global).
- Telemetry, analytics, or remote crash reporting.
- Voice commands / formatting macros (e.g., "new paragraph").
- Fine-tuning models.

---

## 3. User Workflow

**Primary flow:**
1. Focus a text field in any app.
2. Hold `⌃⌘X` (default).
3. Speak. HUD near the cursor shows a live waveform; menu bar icon pulses.
4. Release the keys. HUD shows a spinner, menu bar icon shows "transcribing" state.
5. Transcript is pasted at the cursor. Subtle "pop" sound plays.

**Correction flow:**
1. User notices the transcript spelled a name wrong.
2. Opens menu bar → "History…" → finds the entry → clicks **Edit**.
3. Corrects the spelling, clicks **Save**.
4. Speakist diffs original vs. edited, extracts `{from: "Brevort", to: "Brevoort"}`, stores it, and promotes the replacement to Deepgram's keyterm list.
5. Next time the user dictates that name, Deepgram gets it right.

**Fallback flow (no focused field / paste blocked):**
- Transcript is left on the clipboard; a native notification appears: *"Copied — couldn't paste. Tap to view history."*
- History entry is marked `not pasted` with the originating app bundle ID.

---

## 4. Product Requirements

### 4.1 Menu bar app behavior
- `LSUIElement = YES` in Info.plist → no Dock icon, not in Cmd+Tab.
- Single `NSStatusItem` with custom SF-Symbol-style template icon.
- Icon states:
  - **Idle**: static mark.
  - **Recording**: gently pulsing dot (peach tint override on template when user allows color).
  - **Transcribing**: indeterminate spinner.
  - **Error**: red dot badge; click surfaces last error.
- Click opens a menu:
  - Status line (e.g., "Ready • Deepgram Nova-3")
  - **Start recording** (for toggle mode, if configured)
  - **History…** (opens the history window)
  - **Recent**: last 5 transcriptions, each a submenu item that copies on click
  - **Settings…**
  - **Pause shortcut** (temporary mute — useful during video calls)
  - **Reveal logs in Finder**
  - **About Speakist**
  - **Quit**

### 4.2 Global shortcut system
- Library: [`KeyboardShortcuts`](https://github.com/sindresorhus/KeyboardShortcuts) by Sindre Sorhus.
- Two shortcut slots, both user-configurable in Settings:
  - `pushToTalk` — default `⌃⌘X`. Hold to record; release to transcribe.
  - `toggleRecord` — no default. Tap to start, tap to stop.
- Must work even when Speakist is not the frontmost app (it never is — `LSUIElement`).
- Detect shortcut conflicts and warn in Settings ("This combo is used by another app — it may not fire reliably").

### 4.3 Recording pipeline
- `AVAudioEngine` + `AVAudioInputNode` capturing at 16 kHz mono PCM.
- Circular buffer in memory; on release, write to a temp `.wav` (or `.flac` to save bandwidth).
- Configurable input device (defaults to system default, follows AirPods/headset connects).
- **Minimum duration: 300 ms** — anything shorter is silently discarded (no API call, no history).
- **Maximum duration: 5 min** (user-configurable 1–15 min). At cutoff, recording stops, transcription proceeds, notification: *"Hit max recording length — transcribing what we have."*
- VU meter data streamed to the HUD for the waveform.
- Post-transcription: audio file is retained only if the **Keep audio** setting is on (default: keep last 20, user-tunable 0–200).

### 4.4 Transcription pipeline
- **Batch only**: full audio clip uploaded on release.
- Deepgram only.
- Timeouts: 30 s request timeout; on failure, retry once with 500 ms backoff; on second failure, show error notification and preserve audio for manual re-send from History.
- Requests include a `keyterm[]` (Nova-3) or `keywords[]` (Nova-2) list populated with the current proper-noun-corrections, capped at 50 terms.

#### 4.4.1 Deepgram adapter
- Endpoint: `POST https://api.deepgram.com/v1/listen`
- Model: `nova-3` (default); also expose `nova-2` in Settings.
- Params: `smart_format=true`, `punctuate=true`, `language=en` (when "English only" selected; omit for auto-detect).
- Custom vocab: `keyterm[]` for Nova-3, `keywords[]` for Nova-2.
- Auth header: `Authorization: Token {apiKey}`.
- Audio: upload as `audio/wav`.

### 4.5 Paste-at-cursor
1. Capture current `NSPasteboard.general` contents (all types, not just string) into a snapshot.
2. Write transcript as plain string (`.string` type only).
3. Post a synthetic `Cmd+V` via `CGEvent` keyboard events to the current `kCGHIDEventTap`.
4. Wait ~80 ms, then restore the snapshot to the pasteboard (with `changeCount` guard — skip restore if the user copied something in the interim).
5. If focused app's AX tree reveals no text-editable element, **skip the synthetic keystroke**, leave the transcript on the clipboard, and fire the "couldn't paste" notification.

**Accessibility permission** is required for step 3; we check `AXIsProcessTrusted()` at launch and in the onboarding flow.

### 4.7 History

#### Storage
- SQLite via [GRDB.swift](https://github.com/groue/GRDB.swift), file at `~/Library/Application Support/Speakist/history.sqlite`.
- Schema (see §5.3).
- Rolling retention: **delete rows older than 90 days OR beyond the 1000 most recent**, whichever is stricter. Retention window + count configurable in Settings.
- Audio files purged independently: "keep last N" with N configurable 0–200.

#### UI
- History window (SwiftUI, independent `WindowGroup`, not a sheet).
- Left pane: list of entries (time, first 60 chars, status icons for *edited* / *not pasted*).
- Right pane: selected entry detail:
  - **Raw transcript** (monospaced, read-only).
  - **Final transcript** (multiline editor — edits live-save on blur).
  - Timestamp, duration, provider, model, cost estimate.
  - Buttons: **Copy**, **Paste into frontmost app**, **Re-transcribe** (if audio retained), **Delete**.
  - Inline play/pause of retained audio (AVAudioPlayer).
- Search box (full-text over raw + final).
- Filter chips: *Edited*, *Not pasted*, *With audio*.
- `⌘F` focuses search; `⌘C` copies current entry; `Delete` removes selected (with undo toast).

### 4.8 Correction learning

**Detection:**
- On history-entry save, diff `raw_transcript` vs `final_transcript` using word-level [Myers diff](https://github.com/johnfairh/swift-diff) (or a lightweight hand-rolled LCS over tokens).
- Extract replacement pairs where a run of 1–4 tokens maps to a different 1–4-token run.
- Filter out grammar-only changes (punctuation, casing of common words) — they don't get promoted to the STT vocab.
- For each pair, upsert into `corrections` table: increment `count`, update `last_seen`.

**Promotion to STT vocab:**
- Heuristic: a correction is "proper-noun-like" if the `to` side is capitalized OR contains a digit OR is not in `/usr/share/dict/words`.
- On each transcription, take the top 50 proper-noun-like corrections sorted by `count desc, last_seen desc` and feed them to Deepgram's `keyterm[]` (Nova-3) or `keywords[]` (Nova-2).

**Settings UI:**
- **Settings → Vocabulary** tab: a table of all corrections (`from`, `to`, `count`, `last_seen`, auto-promoted checkbox).
- User can add/edit/delete rows directly — useful to seed names before ever dictating.

### 4.9 Settings

Sections (tabs):

1. **General**
   - Launch at login (via `SMAppService.mainApp`)
   - Play start/stop sounds (default ON)
   - Show HUD overlay (default ON)
   - Pause shortcut temporarily (menu mirror)

2. **Shortcuts**
   - `KeyboardShortcuts.Recorder` for `pushToTalk` (default `⌃⌘X`)
   - `KeyboardShortcuts.Recorder` for `toggleRecord` (default: unset)
   - Conflict warning inline

3. **Audio**
   - Input device picker
   - Min / max duration sliders
   - **Keep audio** toggle + "Keep last N" stepper

4. **Transcription**
   - Deepgram: API key (secure field, stored in Keychain), model dropdown (Nova-3 / Nova-2)
   - Language (default: English)
   - "Test recording" button (records 2 s, shows resulting transcript)

5. **Vocabulary** — table of learned corrections (see §4.7)

6. **History**
   - Retention days (default 90)
   - Max entries (default 1000)
   - **Clear all history** button (double-confirm)
   - **Reveal database in Finder**

7. **Usage** — Deepgram minutes + estimated cost (see §4.10)

8. **About** — version, check for updates (Sparkle), licenses, link to GitHub.

The Deepgram API key is stored in the **macOS Keychain** via Keychain Services (service = `com.brevoort-studio.speakist.apikeys`, account = `deepgram`). Never written to disk in plaintext.

### 4.10 Onboarding

Four-pane onboarding on first launch (and re-openable from menu):

1. **Welcome** — brand splash, one-sentence pitch, "Get started" CTA.
2. **Permissions**:
   - Microphone — triggers `AVCaptureDevice.requestAccess(for: .audio)`.
   - Accessibility — polls `AXIsProcessTrusted()`; opens System Settings deep-link (`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`). UI updates live when granted.
3. **Deepgram setup** — paste Deepgram key. "Test recording" button does a 2-sec round-trip so the user sees real output before leaving onboarding.
4. **Launch at login** — one-question prompt, default unchecked. Then "You're ready! Try ⌃⌘X anywhere."

### 4.10 Usage tracking
- On each transcription, record to `usage` table: provider, model, audio seconds.
- Hard-coded rate table (user-editable in Settings → Usage → "Edit rates"):
  - Deepgram Nova-3: $0.0043/min, Nova-2: $0.0043/min (placeholder — editable)
- Usage tab shows last 7 / 30 / all-time rollups.

### 4.11 Error handling
| Condition | Behavior |
|---|---|
| Missing API key | Notification + opens Settings |
| Mic permission denied | Notification + opens System Settings deep-link |
| Accessibility permission denied | Notification + opens System Settings deep-link |
| STT HTTP error (5xx / timeout) | Retry once, then notification; audio preserved; history row marked `transcription_failed` |
| STT HTTP error (4xx auth) | Notification "API key rejected — check Settings" |
| Paste fails (no text field) | See §4.5 fallback |
| Mic in use / unavailable | Notification; ignore shortcut |
| Shortcut pressed during active transcription | Ignore (debounce) |

All errors also written to a rolling log file at `~/Library/Logs/Speakist/speakist.log` (rotated at 5 MB, keep 3).

---

## 5. Technical Architecture

### 5.1 Tech stack
- **Language**: Swift 5.10+
- **UI**: SwiftUI (menu bar extras, Settings, History window, HUD, Onboarding)
- **Min OS**: macOS 14 (Sonoma)
- **Build**: Xcode 15+, SPM for dependencies
- **CI**: GitHub Actions (build, test, notarize, Sparkle feed)
- **Signing**: Developer ID Application certificate; notarized via `notarytool`; stapled.
- **Bundle ID**: `com.brevoort-studio.speakist`

### 5.2 Module layout (Swift packages / groups)
```
Speakist.xcodeproj
├── App/
│   ├── SpeakistApp.swift               // @main, NSApplicationDelegate, LSUIElement
│   └── AppEnvironment.swift            // DI container
├── MenuBar/
│   ├── MenuBarController.swift         // NSStatusItem + menu
│   └── MenuBarIconRenderer.swift       // idle/recording/transcribing/error states
├── Shortcut/
│   └── ShortcutManager.swift           // wraps KeyboardShortcuts; holds push-to-talk state
├── Recording/
│   ├── AudioRecorder.swift             // AVAudioEngine capture
│   ├── AudioLevelMeter.swift           // for HUD waveform
│   └── DeviceMonitor.swift             // tracks input device changes
├── Transcription/
│   ├── TranscriptionService.swift      // orchestrator
│   ├── DeepgramClient.swift
│   └── TranscriptionService.swift     // orchestrator
├── Paste/
│   ├── CursorInserter.swift            // clipboard + Cmd+V dance
│   └── FocusedFieldProbe.swift         // AX tree check
├── Corrections/
│   ├── DiffEngine.swift                // word diff → pair extraction
│   ├── CorrectionStore.swift           // GRDB access
│   └── VocabularyBuilder.swift         // prompts, keyterms
├── History/
│   ├── HistoryStore.swift              // GRDB access
│   ├── HistoryWindow.swift             // SwiftUI window
│   └── AudioArchive.swift              // file lifecycle
├── Settings/
│   ├── SettingsWindow.swift
│   ├── KeychainStore.swift
│   └── Preferences.swift               // @AppStorage-wrapped prefs
├── HUD/
│   ├── RecordingHUD.swift              // borderless floating window
│   └── WaveformView.swift
├── Onboarding/
│   └── OnboardingWindow.swift
├── Permissions/
│   ├── MicPermission.swift
│   └── AccessibilityPermission.swift
├── Usage/
│   └── UsageTracker.swift
├── Updates/
│   └── UpdaterController.swift         // Sparkle 2
├── Logging/
│   └── Logger.swift                    // os.Logger + file sink
└── Resources/
    ├── Assets.xcassets                 // icon, colors
    └── Brand.swift                     // color palette
```

### 5.3 Data model (SQLite / GRDB)
```sql
CREATE TABLE transcriptions (
    id TEXT PRIMARY KEY,                    -- UUID
    created_at INTEGER NOT NULL,            -- epoch ms
    duration_ms INTEGER NOT NULL,
    provider TEXT NOT NULL,                 -- 'deepgram'
    model TEXT NOT NULL,
    raw_transcript TEXT NOT NULL,
    final_transcript TEXT NOT NULL,         -- == raw until user edits
    cleanup_applied INTEGER NOT NULL,       -- always 0 (legacy column)
    audio_path TEXT,                        -- nullable if audio purged
    target_bundle_id TEXT,                  -- app user was focused in
    paste_status TEXT NOT NULL,             -- 'pasted' | 'clipboard_only' | 'failed'
    transcription_status TEXT NOT NULL,     -- 'ok' | 'failed'
    error_message TEXT,
    edited_at INTEGER                        -- nullable
);
CREATE INDEX idx_transcriptions_created ON transcriptions(created_at DESC);

CREATE VIRTUAL TABLE transcriptions_fts USING fts5(
    raw_transcript, final_transcript,
    content='transcriptions', content_rowid='rowid'
);

CREATE TABLE corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_text TEXT NOT NULL,
    to_text TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    last_seen INTEGER NOT NULL,
    is_proper_noun INTEGER NOT NULL,        -- 0 | 1
    user_managed INTEGER NOT NULL DEFAULT 0,-- 1 if manually added/edited
    UNIQUE(from_text, to_text)
);
CREATE INDEX idx_corrections_rank ON corrections(count DESC, last_seen DESC);

CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    audio_seconds REAL,
    cleanup_input_tokens INTEGER,           -- legacy; unused
    cleanup_output_tokens INTEGER           -- legacy; unused
);
CREATE INDEX idx_usage_created ON usage(created_at DESC);
```

### 5.4 Key external dependencies (SPM)
| Dependency | Purpose |
|---|---|
| `sindresorhus/KeyboardShortcuts` | Global shortcut with hold/release semantics |
| `groue/GRDB.swift` | SQLite access |
| `sparkle-project/Sparkle` | Auto-update |
| `SwiftyJSON` (or stdlib `JSONDecoder`) | API response parsing |
| `apple/swift-log` (optional) | Structured logging façade |

Deliberately avoided: Alamofire (URLSession suffices), any telemetry SDK.

### 5.5 Security & Privacy
- API keys → Keychain only.
- Audio files → Application Support, not sync-eligible (set `com.apple.MobileMeta.ExcludeFromBackup` xattr optional).
- History DB unencrypted (macOS FileVault handles disk-level). Document this in About.
- No network calls besides: Deepgram (transcription), Sparkle update feed.
- **Privacy manifest** (`PrivacyInfo.xcprivacy`) declaring: microphone use, user data types (audio, voice/sound recordings), domains contacted.

---

## 6. UI / Brand

### 6.1 Brand
- **Name**: Speakist
- **Wordmark**: custom letterforms, slightly rounded, lowercase "speakist" preferred for friendliness.
- **Primary**: Peach `#FF8A65`
- **Secondary / accent**: Deep plum `#4A2C5A`
- **Surface**: Cream `#FFF6EE` (light), plum-tinted near-black `#1B1322` (dark)
- **Success**: Sage `#7FB77E`  |  **Warning**: Mustard `#E4B63A`  |  **Error**: Coral red `#E5484D`
- **Icon**: a rounded speech bubble whose tail morphs into a stylized three-bar waveform. Tail bars animate in Recording state.
- **Type**: SF Pro (system). No custom font ship.

### 6.2 Menu bar icon
- Template image (`isTemplate = true`) so it inherits light/dark system tint by default.
- On Recording/Transcribing, override with peach color (`NSImage.withTintColor` or custom `CIFilter`) — visible without being garish.

### 6.3 HUD overlay
- Floating borderless window, ~320×64, rounded 16, translucent material (`.hudWindow`).
- Positioned ~24 pt above the current mouse cursor (snap to nearest screen edge if off-screen).
- Contents:
  - Left: peach pulsing dot (recording) or mini spinner (transcribing).
  - Middle: live waveform (12 bars, driven by VU meter RMS).
  - Right: elapsed time `0:03`.
- Fades in 120 ms on record start; fades out 180 ms after paste completes.

### 6.4 Settings window
- SwiftUI `Settings` scene with tabbed `Form`s.
- Fixed width 560, min height 400.
- Peach primary accent (`.tint(.speakistPeach)`).

### 6.5 History window
- Standard `WindowGroup` (resizable, remembered size).
- Min 720×480.
- Toolbar: search field, filter menu, "Export…" (CSV of transcripts).

### 6.6 Sounds
- Start/stop: system `Tink` / `Pop` played via `NSSound` (respects system volume). Togglable.

---

## 7. Default copy

### 7.1 Notification copy
| Event | Title | Body |
|---|---|---|
| Paste failed | "Copied to clipboard" | "Couldn't paste where your cursor is — paste manually with ⌘V." |
| Transcription failed | "Transcription failed" | "{error}. Audio saved — retry from History." |
| Max duration hit | "Reached max recording length" | "Transcribing the first {N} minutes." |
| Key rejected | "API key rejected" | "Check your {provider} key in Settings." |
| Mic permission denied | "Microphone access needed" | "Open System Settings to enable." |
| Accessibility denied | "Accessibility access needed" | "Speakist needs it to paste at your cursor." |

---

## 8. Distribution & Release

- **Build & sign**: Xcode archive → export with Developer ID Application cert → `notarytool submit --wait` → `stapler staple`.
- **Channel**: Direct download from `speakist.ai` (or GitHub Releases) as a `.dmg` with a background image showing drag-to-Applications.
- **Auto-update**: Sparkle 2 with EdDSA-signed appcast at `https://speakist.ai/appcast.xml`.
- **Versioning**: SemVer. CFBundleShortVersionString = marketing; CFBundleVersion = monotonic build number.
- **First-run launch**: standard Gatekeeper flow (right-click → Open first time is NOT needed because we're notarized).

---

## 9. Verification / Test Plan

### 9.1 Automated
- **Unit tests** (XCTest, `SpeakistTests` target):
  - `DiffEngine` → known transcript pairs produce expected correction tuples.
  - `VocabularyBuilder` → correct ranking, limits respected.
  - `CursorInserter` (with mocked pasteboard + CGEvent post) → clipboard restored on success, left intact on fallback.
  - `DeepgramClient` → request building, error-path retries (using `URLProtocol` stub).
  - Correction promotion heuristic (proper-noun-ish) over a fixture of 50 edits.
  - History retention purge logic (time + count).
- **UI tests** (XCUITest, `SpeakistUITests` target):
  - Onboarding happy path.
  - Settings round-trip (write / read back API keys via keychain; shortcut recorder).
  - History edit → correction appears in Vocabulary tab.

### 9.2 Manual integration checklist (run before each release)
Run in this order on a clean macOS 14 VM:
- [ ] Fresh launch → onboarding appears. Grant mic + accessibility.
- [ ] Paste Deepgram key → Test recording → transcript appears.
- [ ] Default shortcut `⌃⌘X`: in TextEdit, hold + speak + release → transcribed text pasted.
- [ ] Same shortcut in Chrome (gmail compose), VS Code, Slack, Terminal — paste works in each.
- [ ] Dictate into a web field with no focus → notification appears, transcript on clipboard.
- [ ] Record a 300 ms blip → silently discarded, no history row.
- [ ] Record past 5 min → auto-stops with notification; transcript saved.
- [ ] Edit a name in history → correction appears in Vocabulary tab; next dictation of that name is correct.
- [ ] Kill network mid-transcription → error notification; audio retained; re-transcribe from history succeeds.
- [ ] Launch at login toggle survives reboot.
- [ ] Pause shortcut → shortcut is inert until unpaused.
- [ ] Delete all history → rows + audio files removed.
- [ ] Usage tab shows minute and cost tallies after a few recordings.
- [ ] Sparkle update to a staged newer build succeeds.
- [ ] `codesign --verify --deep --strict Speakist.app` passes.
- [ ] `spctl --assess --type execute Speakist.app` returns "accepted".

### 9.3 Performance targets
- Time from shortcut release to paste (5-s clip, Deepgram Nova-3): **< 2.0 s p50**.
- Idle RAM: **< 80 MB**.
- Idle CPU: **< 0.5%** averaged over 1 min.
- Binary size: **< 25 MB** (unsigned).

---

## 10. Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 — Scaffold** | Xcode project, menu bar skeleton, app delegate, `LSUIElement`, brand assets | App launches, menu bar icon visible, no Dock icon |
| **M1 — Record → paste (Deepgram)** | Shortcut, recorder, Deepgram client, clipboard paste, HUD | End-to-end dictation works in TextEdit with hard-coded key |
| **M2 — Settings + onboarding** | Full Settings UI, Keychain, shortcut recorder, onboarding | Key persists; test-recording works |
| **M3 — History** | SQLite schema, history window, audio archive | Every transcription shows up; edits save |
| **M4 — Correction learning** | Diff engine, correction store, vocab promotion, Vocabulary tab | Edits in history demonstrably improve next Deepgram result |
| **M5 — Polish** | Error paths, notifications, usage tab, sounds, HUD waveform, toggle shortcut, retention purge | Full manual checklist green on clean VM |
| **M6 — Release 1.0** | Notarization, Sparkle feed, DMG, landing page, docs | Signed, notarized, auto-updatable build downloadable |

---

## 11. Open items / future work (explicitly out of scope for v1)
- Voice commands ("new paragraph", "comma", "scratch that").
- Per-app profiles (different shortcut, different language).
- On-device transcription fallback for offline dictation.
- iCloud sync of vocabulary and history.
- Streaming partial paste while speaking.
- Optional LLM cleanup pass (removed in favor of simplicity; Deepgram smart_format already handles punctuation/capitalization well).
- Team accounts with managed Deepgram access and usage-based billing.
- iOS companion.
- Sharing / team vocabularies.
