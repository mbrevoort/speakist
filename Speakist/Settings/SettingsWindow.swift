import SwiftUI
import KeyboardShortcuts

struct BrandHeader: View {
    var body: some View {
        HStack(spacing: 10) {
            Image(nsImage: MenuBarIcon.make(fill: NSColor.speakistPeach))
                .resizable()
                .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 0) {
                Text("Speakist")
                    .font(.system(size: 17, weight: .semibold))
                Text("Push-to-talk dictation")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
            }
            Spacer()
        }
    }
}

enum SettingsSection: String, CaseIterable, Identifiable {
    case account, general, shortcuts, audio, transcription, polish, vocabulary, history, about

    var id: String { rawValue }

    var title: String {
        switch self {
        case .account: return "Account"
        case .general: return "General"
        case .shortcuts: return "Shortcuts"
        case .audio: return "Audio"
        case .transcription: return "Transcription"
        case .polish: return "Polish"
        case .vocabulary: return "Vocabulary"
        case .history: return "History"
        case .about: return "About"
        }
    }

    var systemImage: String {
        switch self {
        case .account: return "person.crop.circle"
        case .general: return "gear"
        case .shortcuts: return "keyboard"
        case .audio: return "mic"
        case .transcription: return "waveform"
        case .polish: return "sparkles"
        case .vocabulary: return "character.book.closed"
        case .history: return "clock.arrow.circlepath"
        case .about: return "info.circle"
        }
    }
}

struct SettingsWindow: View {
    @State private var selection: SettingsSection = .account

    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 0) {
                BrandHeader()
                    .padding(.horizontal, 12)
                    .padding(.top, 14)
                    .padding(.bottom, 8)
                Divider()
                List(SettingsSection.allCases, selection: $selection) { section in
                    NavigationLink(value: section) {
                        Label(section.title, systemImage: section.systemImage)
                    }
                }
                .listStyle(.sidebar)
            }
            .navigationSplitViewColumnWidth(min: 200, ideal: 220, max: 260)
        } detail: {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text("Speakist")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.secondary)
                    Text("›")
                        .foregroundColor(.secondary.opacity(0.5))
                    Text(selection.title)
                        .font(.system(size: 20, weight: .semibold))
                    Spacer()
                }
                .padding(.horizontal, 20)
                .padding(.top, 18)
                .padding(.bottom, 6)
                Divider()
                detailView
            }
            .frame(minWidth: 500)
        }
        .navigationSplitViewStyle(.balanced)
        .frame(minWidth: 720, minHeight: 520)
        .tint(.speakistPeach)
    }

    @ViewBuilder
    private var detailView: some View {
        switch selection {
        case .account: AccountSettingsView()
        case .general: GeneralSettingsView()
        case .shortcuts: ShortcutsSettingsView()
        case .audio: AudioSettingsView()
        case .transcription: TranscriptionSettingsView()
        case .polish: PolishSettingsView()
        case .vocabulary: VocabularySettingsView()
        case .history: HistorySettingsView()
        case .about: AboutSettingsView()
        }
    }
}

// MARK: - Account

/// BIGINT millicents → "$N.NN" for the Settings display. Mirrors the web's
/// formatDollars() helper. Kept inline here because it's only one consumer.
private func formatDollars(balanceMillicents: Int) -> String {
    let dollars = Double(balanceMillicents) / 100_000.0
    return NumberFormatter.usd.string(from: NSNumber(value: dollars)) ?? "$\(dollars)"
}

private extension NumberFormatter {
    static let usd: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 2
        return f
    }()
}

struct AccountSettingsView: View {
    @EnvironmentObject var prefs: Preferences
    @EnvironmentObject var manager: SpeakistAccountManager

    var body: some View {
        Form {
            Section {
                switch manager.state {
                case .signedOut:
                    VStack(alignment: .leading, spacing: 10) {
                        Text("You're not signed in yet.")
                            .font(.headline)
                        Text("Sign in to your Speakist account to start transcribing. You'll get $5 in free credit to try it.")
                            .font(.footnote)
                            .foregroundColor(.secondary)
                        Button("Sign in with Speakist") {
                            Task { await manager.startSignIn() }
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                    }
                    .padding(.vertical, 6)

                case .signingIn(let code, let url, let expiresAt):
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Finish signing in")
                            .font(.headline)
                        Text("Your browser should have opened. If not, visit \(url.absoluteString) and enter this code:")
                            .font(.footnote)
                            .foregroundColor(.secondary)
                        Text(code)
                            .font(.system(size: 22, weight: .semibold, design: .monospaced))
                            .foregroundColor(.primary)
                            .kerning(3)
                            .padding(.vertical, 4)
                        HStack {
                            Button("Copy code") {
                                let pb = NSPasteboard.general
                                pb.clearContents()
                                pb.setString(code, forType: .string)
                            }
                            .buttonStyle(.bordered)
                            Button("Open link again") {
                                NSWorkspace.shared.open(url)
                            }
                            .buttonStyle(.bordered)
                            Spacer()
                            Button("Cancel") {
                                manager.signOut()
                            }
                        }
                        Text("Expires \(expiresAt.formatted(date: .omitted, time: .shortened))")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    .padding(.vertical, 6)

                case .signedIn(let identity):
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 10) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundColor(.green)
                                .font(.system(size: 20))
                            VStack(alignment: .leading, spacing: 2) {
                                if let id = identity {
                                    Text(id.displayName ?? id.email)
                                        .font(.headline)
                                    Text(id.email)
                                        .font(.footnote)
                                        .foregroundColor(.secondary)
                                } else {
                                    Text("Signed in")
                                        .font(.headline)
                                    Text("Loading your account details…")
                                        .font(.footnote)
                                        .foregroundColor(.secondary)
                                }
                            }
                            Spacer()
                        }

                        if let id = identity, let org = id.orgName {
                            Divider()
                            HStack(spacing: 8) {
                                Image(systemName: "building.2")
                                    .foregroundColor(.secondary)
                                    .frame(width: 18)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(org).font(.callout.weight(.medium))
                                    HStack(spacing: 6) {
                                        if let role = id.orgRole {
                                            Text(role.capitalized)
                                                .font(.caption)
                                                .foregroundColor(.secondary)
                                        }
                                        if let bal = id.balanceMillicents {
                                            Text("·")
                                                .foregroundColor(.secondary.opacity(0.5))
                                            Text(formatDollars(balanceMillicents: bal))
                                                .font(.caption.monospacedDigit())
                                                .foregroundColor(bal < 0 ? .red : .secondary)
                                        }
                                    }
                                }
                                Spacer()
                            }
                            // Each user belongs to exactly one workspace at
                            // a time. To switch, leave the current
                            // workspace from the web dashboard's settings
                            // page (deleting it first if you're the sole
                            // owner), then accept a pending invitation or
                            // create a new workspace on next sign-in.
                        }

                        HStack {
                            Button("Open dashboard") {
                                NSWorkspace.shared.open(prefs.apiBaseURL.appendingPathComponent("dashboard"))
                            }
                            .buttonStyle(.bordered)
                            Button("Top up credit") {
                                NSWorkspace.shared.open(prefs.apiBaseURL.appendingPathComponent("dashboard/billing"))
                            }
                            .buttonStyle(.bordered)
                            Button("Usage") {
                                NSWorkspace.shared.open(prefs.apiBaseURL.appendingPathComponent("dashboard/usage"))
                            }
                            .buttonStyle(.bordered)
                            Spacer()
                            Button("Sign out", role: .destructive) {
                                manager.signOut()
                            }
                        }
                    }
                    .padding(.vertical, 6)
                    .task { await manager.refreshIdentity() }
                }

                if let err = manager.lastError {
                    Text(err)
                        .font(.footnote)
                        .foregroundColor(.red)
                }
            } header: {
                Text("Speakist account")
            }

            Section {
                LabeledContent("API endpoint", value: prefs.apiBaseURL.absoluteString)
                    .font(.system(.body, design: .monospaced))
                Text("Change with: `defaults write \(AppIdentity.bundleID) apiBaseURL \"https://speakist.ai\"` and restart the app.")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            } header: {
                Text("Advanced")
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

// MARK: - General

struct GeneralSettingsView: View {
    @EnvironmentObject var prefs: Preferences

    var body: some View {
        Form {
            Section {
                Toggle("Launch Speakist at login", isOn: Binding(
                    get: { prefs.launchAtLogin },
                    set: { prefs.launchAtLogin = $0 }))
                Toggle("Play start/stop sounds", isOn: Binding(
                    get: { prefs.playSounds },
                    set: { prefs.playSounds = $0 }))
                Toggle("Show overlay UI while recording", isOn: Binding(
                    get: { prefs.showHUD },
                    set: { prefs.showHUD = $0 }))
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

// MARK: - Shortcuts

struct ShortcutsSettingsView: View {
    @EnvironmentObject var prefs: Preferences

    var body: some View {
        Form {
            Section("Dictation") {
                HStack {
                    Text("Hold to record")
                    Spacer()
                    KeyboardShortcuts.Recorder(for: .pushToTalk)
                }
                Text("Hold the shortcut, speak, and release to transcribe.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }
            Section("Toggle mode") {
                HStack {
                    Text("Tap to start / tap to stop")
                    Spacer()
                    KeyboardShortcuts.Recorder(for: .toggleRecord)
                }
                Text("Optional alternative for longer dictations where holding is uncomfortable.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }
            Section {
                Toggle("Pause dictation shortcut", isOn: Binding(
                    get: { prefs.shortcutPaused },
                    set: { prefs.shortcutPaused = $0 }))
                Text("Temporarily mute the global shortcut without clearing it. Useful during video calls or screen recordings.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

// MARK: - Audio

struct AudioSettingsView: View {
    @EnvironmentObject var prefs: Preferences
    @EnvironmentObject var devices: DeviceMonitor

    var body: some View {
        Form {
            Section("Input") {
                Picker("Microphone", selection: Binding(
                    get: { prefs.inputDeviceUID ?? "__default__" },
                    set: { prefs.inputDeviceUID = $0 == "__default__" ? nil : $0 })) {
                    Text("System default").tag("__default__")
                    ForEach(devices.inputs) { device in
                        Text(device.name).tag(device.uid)
                    }
                }
                .pickerStyle(.menu)
            }

            Section("Limits") {
                Stepper(value: Binding(
                    get: { prefs.minDurationMs },
                    set: { prefs.minDurationMs = $0 }), in: 0...2_000, step: 50) {
                    HStack {
                        Text("Minimum duration")
                        Spacer()
                        Text("\(prefs.minDurationMs) ms")
                            .foregroundColor(.secondary)
                    }
                }
                Stepper(value: Binding(
                    get: { prefs.maxDurationSec },
                    set: { prefs.maxDurationSec = $0 }), in: 60...900, step: 30) {
                    HStack {
                        Text("Maximum duration")
                        Spacer()
                        Text("\(prefs.maxDurationSec / 60) min \(prefs.maxDurationSec % 60) s")
                            .foregroundColor(.secondary)
                    }
                }
            }

            Section("Audio retention") {
                Toggle("Keep audio for recent transcriptions", isOn: Binding(
                    get: { prefs.keepAudio },
                    set: { prefs.keepAudio = $0 }))
                Stepper(value: Binding(
                    get: { prefs.keepAudioCount },
                    set: { prefs.keepAudioCount = $0 }), in: 0...200) {
                    HStack {
                        Text("Keep last")
                        Spacer()
                        Text("\(prefs.keepAudioCount) clips")
                            .foregroundColor(.secondary)
                    }
                }
                .disabled(!prefs.keepAudio)
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

// MARK: - Transcription

struct TranscriptionSettingsView: View {
    @EnvironmentObject var prefs: Preferences
    @EnvironmentObject var env: AppEnvironment

    @State private var testOutput: String = ""
    @State private var testing = false

    var body: some View {
        Form {
            // Provider + model selection lives in the super admin org page now.
            // English defaults to Groq Whisper Turbo (fastest); other languages
            // default to Groq Whisper Large (most accurate multilingual).
            // A super admin can override per-org via the allowed-models list.
            // The Mac side just sends the chosen language and lets the Worker
            // resolve which model to call.
            Section {
                Picker("Language", selection: Binding(
                    get: { prefs.language },
                    set: { prefs.language = $0 })) {
                    Text("English").tag("en")
                    Text("Auto-detect").tag("")
                }
                Text("Choosing English uses a transcription engine optimized for speed and English accuracy. Other languages and Auto-detect use a multilingual engine.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            } header: {
                Text("Language")
            }

            Section("Diagnostics") {
                Button(testing ? "Recording…" : "Test recording (2 seconds)") {
                    Task { await runTestRecording() }
                }
                .disabled(testing || env.permissions.mic != .granted)
                if !testOutput.isEmpty {
                    Text(testOutput)
                        .font(.callout)
                        .foregroundColor(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    private func runTestRecording() async {
        testing = true
        testOutput = "Recording…"
        defer { testing = false }

        // Gate on sign-in — test recording needs to mint a Deepgram token,
        // which needs a Speakist session.
        guard env.accountManager.isSignedIn else {
            testOutput = "Sign in on the Account tab first, then try again."
            return
        }

        do {
            try await env.audioRecorder.start()
        } catch {
            testOutput = "Couldn't start: \(error.localizedDescription)"
            return
        }
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        guard let rec = env.audioRecorder.stop() else {
            testOutput = "No recording captured."
            return
        }

        testOutput = "Transcribing…"
        do {
            // Mirror the production path: use SpeakistTranscribeClient when
            // the proxy pref is on, else the legacy Deepgram direct path.
            // Keeps test-recording truthful about what a real shortcut press
            // would do with the current settings.
            let result: TranscriptionResult
            if prefs.useTranscribeProxy {
                guard let token = env.accountManager.bearerToken, !token.isEmpty else {
                    testOutput = "Sign in on the Account tab first, then try again."
                    return
                }
                let client = SpeakistTranscribeClient(
                    apiBaseURL: prefs.apiBaseURL,
                    bearerToken: token,
                    transcriptionClientId: UUID().uuidString,
                    dictation: prefs.dictationMode,
                    fillerWords: prefs.includeFillerWords,
                    measurements: prefs.convertMeasurements,
                    profanityFilter: prefs.maskProfanity,
                    detectLanguage: prefs.autoDetectLanguage,
                    replaceRules: [])
                result = try await client.transcribe(
                    audioURL: rec.url,
                    keyterms: [],
                    language: prefs.language.isEmpty ? nil : prefs.language)
            } else {
                let token = try await env.apiClient.mintDeepgramToken()
                let client = DeepgramClient(
                    apiKey: token.key,
                    model: prefs.deepgramModel,
                    dictation: prefs.dictationMode,
                    fillerWords: prefs.includeFillerWords,
                    measurements: prefs.convertMeasurements,
                    profanityFilter: prefs.maskProfanity,
                    detectLanguage: prefs.autoDetectLanguage)
                result = try await client.transcribe(
                    audioURL: rec.url,
                    keyterms: [],
                    language: prefs.language.isEmpty ? nil : prefs.language)
            }
            testOutput = result.text.isEmpty ? "(empty transcript)" : result.text
        } catch SpeakistAPIClient.Error.insufficientCredit {
            testOutput = "Out of credit. Top up in the Account tab."
        } catch {
            testOutput = "Error: \(error.localizedDescription)"
        }
        try? FileManager.default.removeItem(at: rec.url)
    }
}

// MARK: - Polish
//
// Post-transcription LLM polish pass. Settings here mutate the server's
// source-of-truth on PUT — the local Preferences cache is refreshed from
// the PUT's response shape, so the UI always reflects what the server
// saved. Offline writes surface as an inline error; user retries.

struct PolishSettingsView: View {
    @EnvironmentObject var prefs: Preferences
    @EnvironmentObject var env: AppEnvironment

    @State private var savingToggle = false
    @State private var savingMode = false
    @State private var lastError: String?
    @State private var lastSavedAt: Date?

    var body: some View {
        Form {
            Section {
                Toggle("Polish each transcription", isOn: Binding(
                    get: { prefs.polishEnabled },
                    set: { newValue in saveToggle(newValue) }))
                    .disabled(savingToggle)

                Text("Cleans up every transcription before it lands — adds punctuation, capitalization, and clear grammar fixes.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            } header: {
                Text("Post-transcription polish")
            }

            // Mode picker. Always visible (even when polish is off) so
            // a user can configure their preferred mode before flipping
            // the toggle on. The actions disable when polish is off so
            // server state stays consistent with the visual.
            Section {
                Picker("Mode", selection: Binding(
                    get: { prefs.polishMode },
                    set: { saveMode($0) }
                )) {
                    Text("Intuitive").tag(SpeakistAPIClient.PolishMode.intuitive)
                    Text("Prescriptive").tag(SpeakistAPIClient.PolishMode.prescriptive)
                }
                .pickerStyle(.segmented)
                .disabled(!prefs.polishEnabled || savingMode)

                Text(prefs.polishMode == .intuitive
                     ? "Tries to understand your intent and applies explicit self-corrections (\u{201C}I mean…\u{201D}, \u{201C}scratch that…\u{201D}). Best when you talk through a thought and want the polished result."
                     : "Conservative — only fixes punctuation, capitalization, and clear grammar. Never changes meaning or removes content. Best when you want verbatim with formatting.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            } header: {
                Text("Mode")
            } footer: {
                if let err = lastError {
                    Text(err).font(.footnote).foregroundColor(.red)
                } else if let savedAt = lastSavedAt {
                    Text("Saved \(relativeTimeString(savedAt)).")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    // MARK: - Actions

    private func saveToggle(_ newValue: Bool) {
        savingToggle = true
        lastError = nil
        Task {
            defer { savingToggle = false }
            do {
                let resp = try await env.apiClient.updatePolish(enabled: newValue, systemPrompt: nil)
                prefs.applyPolishFromServer(
                    enabled: resp.enabled,
                    mode: resp.mode,
                    systemPrompt: resp.systemPrompt,
                    isCustom: resp.isCustom,
                    defaultPrompt: resp.defaultPrompt
                )
                lastSavedAt = Date()
            } catch {
                lastError = "Couldn't save: \(error.localizedDescription)"
            }
        }
    }

    private func saveMode(_ newValue: SpeakistAPIClient.PolishMode) {
        guard newValue != prefs.polishMode else { return }
        savingMode = true
        lastError = nil
        Task {
            defer { savingMode = false }
            do {
                let resp = try await env.apiClient.updatePolish(
                    enabled: nil,
                    mode: newValue,
                    systemPrompt: nil
                )
                prefs.applyPolishFromServer(
                    enabled: resp.enabled,
                    mode: resp.mode,
                    systemPrompt: resp.systemPrompt,
                    isCustom: resp.isCustom,
                    defaultPrompt: resp.defaultPrompt
                )
                lastSavedAt = Date()
            } catch {
                lastError = "Couldn't save: \(error.localizedDescription)"
            }
        }
    }

    private func relativeTimeString(_ d: Date) -> String {
        let secs = Int(-d.timeIntervalSinceNow)
        if secs < 5 { return "just now" }
        if secs < 60 { return "\(secs)s ago" }
        if secs < 3600 { return "\(secs / 60)m ago" }
        return "\(secs / 3600)h ago"
    }
}

// MARK: - Vocabulary

struct VocabularySettingsView: View {
    @EnvironmentObject var store: CorrectionStore
    @State private var newFrom = ""
    @State private var newTo = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Learned corrections")
                    .font(.title3.weight(.semibold))
                Spacer()
            }
            Text("Corrections are applied two ways per transcription: proper-noun entries bias the transcription engine when it supports keyterm boosts (so the mistake is less likely to happen again), and every entry is applied as a post-transcription find/replace so any remaining miss still gets fixed in the final text.")
                .font(.footnote)
                .foregroundColor(.secondary)

            Table(store.all) {
                TableColumn("From") { row in
                    TextField("", text: Binding(
                        get: { row.fromText },
                        set: { var copy = row; copy.fromText = $0; store.upsert(copy) }))
                }
                TableColumn("To") { row in
                    TextField("", text: Binding(
                        get: { row.toText },
                        set: { var copy = row; copy.toText = $0; store.upsert(copy) }))
                }
                TableColumn("Count") { row in Text("\(row.count)") }
                    .width(min: 50, max: 70)
                TableColumn("Proper noun") { row in
                    Toggle("", isOn: Binding(
                        get: { row.isProperNoun },
                        set: { var copy = row; copy.isProperNoun = $0; store.upsert(copy) }))
                }
                .width(min: 90, max: 110)
                TableColumn("") { row in
                    Button {
                        store.delete(row)
                    } label: {
                        Image(systemName: "trash")
                    }
                }
                .width(min: 40, max: 50)
            }
            .frame(minHeight: 240)

            Divider()

            HStack {
                TextField("From (misheard)", text: $newFrom)
                TextField("To (correct)", text: $newTo)
                Button("Add") {
                    let f = newFrom.trimmingCharacters(in: .whitespacesAndNewlines)
                    let t = newTo.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !f.isEmpty, !t.isEmpty else { return }
                    store.upsert(CorrectionRow(
                        dbID: nil,
                        fromText: f,
                        toText: t,
                        count: 1,
                        lastSeen: Date(),
                        isProperNoun: DiffEngine.isProperNounLike(t),
                        userManaged: true))
                    newFrom = ""; newTo = ""
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding()
    }
}

// MARK: - History

struct HistorySettingsView: View {
    @EnvironmentObject var prefs: Preferences
    @EnvironmentObject var env: AppEnvironment
    @State private var confirmClear = false

    var body: some View {
        Form {
            Section("Retention") {
                Stepper(value: Binding(
                    get: { prefs.retentionDays },
                    set: { prefs.retentionDays = $0 }), in: 1...365) {
                    HStack {
                        Text("Keep for")
                        Spacer()
                        Text("\(prefs.retentionDays) days")
                            .foregroundColor(.secondary)
                    }
                }
                Stepper(value: Binding(
                    get: { prefs.maxHistoryEntries },
                    set: { prefs.maxHistoryEntries = $0 }), in: 50...10_000, step: 50) {
                    HStack {
                        Text("Keep at most")
                        Spacer()
                        Text("\(prefs.maxHistoryEntries) entries")
                            .foregroundColor(.secondary)
                    }
                }
            }
            Section {
                Button("Reveal database in Finder") {
                    if let url = try? HistoryStore.databaseURL() {
                        NSWorkspace.shared.activateFileViewerSelecting([url])
                    }
                }
                Button("Clear all history…", role: .destructive) {
                    confirmClear = true
                }
                .foregroundColor(.red)
            }
        }
        .formStyle(.grouped)
        .padding()
        .confirmationDialog("Delete all transcription history?",
                            isPresented: $confirmClear,
                            titleVisibility: .visible) {
            Button("Delete everything", role: .destructive) {
                env.historyStore.deleteAll()
                env.audioArchive.removeAll()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes every transcription, all edits, and all archived audio. This cannot be undone.")
        }
    }
}

// MARK: - About

struct AboutSettingsView: View {
    @EnvironmentObject var env: AppEnvironment

    private var version: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
    }

    private var build: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown"
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                // App identity
                VStack(spacing: 10) {
                    Image(nsImage: MenuBarIcon.make(fill: NSColor.speakistPeach))
                        .resizable().aspectRatio(contentMode: .fit)
                        .frame(width: 96, height: 96)
                    Text("Speakist").font(.title.weight(.semibold))
                    Text("Version \(version) (build \(build))")
                        .font(.callout)
                        .foregroundColor(.secondary)
                    Button("Check for updates…") {
                        env.updater.checkForUpdates()
                    }
                    .padding(.top, 2)
                }

                Divider()

                // Privacy copy. Deliberately provider-agnostic — the
                // backend can swap upstream STT providers without
                // requiring a Mac release to update this string.
                Text("Speakist keeps your data on your Mac. Audio and history live in Application Support. Your Speakist sign-in token lives in the Keychain. Audio is sent to our backend, transcribed, and the result is returned. Neither the audio nor the transcript is ever saved or written to disk in the cloud — only on your device.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)

                Divider()

                // Company
                VStack(spacing: 6) {
                    Text("Brevoort Studio LLC")
                        .font(.headline)
                    Text("Colorado, USA")
                        .font(.callout)
                        .foregroundColor(.secondary)
                    HStack(spacing: 12) {
                        Button("Website") {
                            if let url = URL(string: "https://brevoortstudio.com") {
                                NSWorkspace.shared.open(url)
                            }
                        }
                        .buttonStyle(.link)
                        Button("Contact") {
                            if let url = URL(string: "mailto:hello@brevoortstudio.com") {
                                NSWorkspace.shared.open(url)
                            }
                        }
                        .buttonStyle(.link)
                        Button("Privacy") {
                            if let url = URL(string: "https://brevoortstudio.com/privacy") {
                                NSWorkspace.shared.open(url)
                            }
                        }
                        .buttonStyle(.link)
                        Button("Terms") {
                            if let url = URL(string: "https://brevoortstudio.com/terms") {
                                NSWorkspace.shared.open(url)
                            }
                        }
                        .buttonStyle(.link)
                    }
                    Text("© \(Calendar.current.component(.year, from: Date())) Brevoort Studio LLC. All rights reserved.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .padding(.top, 2)
                }
            }
            .padding(.vertical, 24)
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity)
        }
    }
}
