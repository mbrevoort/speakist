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
    case general, shortcuts, audio, transcription, cleanup, vocabulary, history, usage, about

    var id: String { rawValue }

    var title: String {
        switch self {
        case .general: return "General"
        case .shortcuts: return "Shortcuts"
        case .audio: return "Audio"
        case .transcription: return "Transcription"
        case .cleanup: return "Cleanup"
        case .vocabulary: return "Vocabulary"
        case .history: return "History"
        case .usage: return "Usage"
        case .about: return "About"
        }
    }

    var systemImage: String {
        switch self {
        case .general: return "gear"
        case .shortcuts: return "keyboard"
        case .audio: return "mic"
        case .transcription: return "waveform"
        case .cleanup: return "sparkles"
        case .vocabulary: return "character.book.closed"
        case .history: return "clock.arrow.circlepath"
        case .usage: return "chart.bar"
        case .about: return "info.circle"
        }
    }
}

struct SettingsWindow: View {
    @State private var selection: SettingsSection = .general

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
        case .general: GeneralSettingsView()
        case .shortcuts: ShortcutsSettingsView()
        case .audio: AudioSettingsView()
        case .transcription: TranscriptionSettingsView()
        case .cleanup: CleanupSettingsView()
        case .vocabulary: VocabularySettingsView()
        case .history: HistorySettingsView()
        case .usage: UsageSettingsView()
        case .about: AboutSettingsView()
        }
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
                Toggle("Show HUD overlay while recording", isOn: Binding(
                    get: { prefs.showHUD },
                    set: { prefs.showHUD = $0 }))
                Toggle("Pause dictation shortcut", isOn: Binding(
                    get: { prefs.shortcutPaused },
                    set: { prefs.shortcutPaused = $0 }))
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

// MARK: - Shortcuts

struct ShortcutsSettingsView: View {
    var body: some View {
        Form {
            Section("Dictation") {
                HStack {
                    Text("Hold to record")
                    Spacer()
                    KeyboardShortcuts.Recorder(for: .pushToTalk)
                }
                Text("Hold Shift as you release to skip the cleanup pass and paste the raw transcript.")
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
    @EnvironmentObject var keychain: KeychainStore
    @EnvironmentObject var env: AppEnvironment

    @State private var deepgramKey: String = ""
    @State private var openaiKey: String = ""
    @State private var testOutput: String = ""
    @State private var testing = false

    var body: some View {
        Form {
            Section("Provider") {
                Picker("Active provider", selection: Binding(
                    get: { prefs.activeProvider },
                    set: { prefs.activeProvider = $0 })) {
                    ForEach(TranscriptionProvider.allCases) { p in
                        Text(p.displayName).tag(p)
                    }
                }
                .pickerStyle(.segmented)
                Picker("Language", selection: Binding(
                    get: { prefs.language },
                    set: { prefs.language = $0 })) {
                    Text("English").tag("en")
                    Text("Auto-detect").tag("")
                }
            }

            Section("Deepgram") {
                SecureField("API key", text: $deepgramKey, onCommit: {
                    keychain.set(deepgramKey, for: .deepgram)
                })
                Button("Save") { keychain.set(deepgramKey, for: .deepgram) }
                Picker("Model", selection: Binding(
                    get: { prefs.deepgramModel },
                    set: { prefs.deepgramModel = $0 })) {
                    ForEach(DeepgramModel.allCases) { m in
                        Text(m.displayName).tag(m)
                    }
                }
            }

            Section("OpenAI") {
                SecureField("API key", text: $openaiKey, onCommit: {
                    keychain.set(openaiKey, for: .openai)
                })
                Button("Save") { keychain.set(openaiKey, for: .openai) }
                Picker("Transcription model", selection: Binding(
                    get: { prefs.openaiTranscribeModel },
                    set: { prefs.openaiTranscribeModel = $0 })) {
                    ForEach(OpenAITranscribeModel.allCases) { m in
                        Text(m.displayName).tag(m)
                    }
                }
            }

            Section("Diagnostics") {
                Button(testing ? "Recording…" : "Test recording (2 s)") {
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
        .onAppear {
            deepgramKey = keychain.get(.deepgram) ?? ""
            openaiKey = keychain.get(.openai) ?? ""
        }
    }

    private func runTestRecording() async {
        testing = true
        testOutput = "Recording…"
        defer { testing = false }

        do {
            try env.audioRecorder.start()
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
        guard let client = buildClient() else {
            testOutput = "No API key configured."
            return
        }
        do {
            let result = try await client.transcribe(
                audioURL: rec.url,
                keyterms: [],
                language: prefs.language.isEmpty ? nil : prefs.language)
            testOutput = result.text.isEmpty ? "(empty transcript)" : result.text
        } catch {
            testOutput = "Error: \(error.localizedDescription)"
        }
        try? FileManager.default.removeItem(at: rec.url)
    }

    private func buildClient() -> TranscriptionClient? {
        switch prefs.activeProvider {
        case .deepgram:
            guard let k = keychain.get(.deepgram), !k.isEmpty else { return nil }
            return DeepgramClient(apiKey: k, model: prefs.deepgramModel)
        case .openai:
            guard let k = keychain.get(.openai), !k.isEmpty else { return nil }
            return OpenAITranscribeClient(apiKey: k, model: prefs.openaiTranscribeModel)
        }
    }
}

// MARK: - Cleanup

struct CleanupSettingsView: View {
    @EnvironmentObject var prefs: Preferences

    var body: some View {
        Form {
            Section {
                Toggle("Enable cleanup pass (requires OpenAI key)", isOn: Binding(
                    get: { prefs.cleanupEnabled },
                    set: { prefs.cleanupEnabled = $0 }))
                Picker("Cleanup model", selection: Binding(
                    get: { prefs.cleanupModel },
                    set: { prefs.cleanupModel = $0 })) {
                    ForEach(CleanupModel.allCases) { m in
                        Text(m.displayName).tag(m)
                    }
                }
                .disabled(!prefs.cleanupEnabled)
                Toggle("Include learned corrections in the prompt", isOn: Binding(
                    get: { prefs.includeCorrectionsInCleanup },
                    set: { prefs.includeCorrectionsInCleanup = $0 }))
                .disabled(!prefs.cleanupEnabled)
            }

            Section("System prompt") {
                TextEditor(text: Binding(
                    get: { prefs.cleanupSystemPrompt },
                    set: { prefs.cleanupSystemPrompt = $0 }))
                .font(.system(.callout, design: .monospaced))
                .frame(minHeight: 220)
                Button("Restore default") {
                    prefs.cleanupSystemPrompt = Preferences.defaultCleanupPrompt
                }
            }
        }
        .formStyle(.grouped)
        .padding()
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
            Text("Speakist promotes proper-noun edits to your STT custom-vocabulary and injects every correction into the cleanup prompt.")
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

// MARK: - Usage

struct UsageSettingsView: View {
    @EnvironmentObject var prefs: Preferences
    @EnvironmentObject var usage: UsageTracker
    @State private var window: UsageWindow = .last30Days

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Usage & estimated cost").font(.title3.weight(.semibold))
                Spacer()
                Picker("", selection: $window) {
                    ForEach(UsageWindow.allCases) { w in
                        Text(w.title).tag(w)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
            }

            row(provider: "deepgram", label: "Deepgram Nova-3", model: DeepgramModel.nova3.rawValue)
            row(provider: "deepgram", label: "Deepgram Nova-2", model: DeepgramModel.nova2.rawValue)
            row(provider: "openai", label: "OpenAI mini-transcribe", model: OpenAITranscribeModel.gpt4oMiniTranscribe.rawValue)
            row(provider: "openai", label: "OpenAI gpt-4o transcribe", model: OpenAITranscribeModel.gpt4oTranscribe.rawValue)
            row(provider: "openai", label: "OpenAI whisper-1", model: OpenAITranscribeModel.whisper1.rawValue)

            Divider()
            Text("Rates (editable) are per-minute for transcription and per 1M tokens for the cleanup model. Published rates change — adjust these to match your account.")
                .font(.footnote)
                .foregroundColor(.secondary)

            Form {
                Section("Rates (USD)") {
                    rateField(title: "Deepgram Nova-3 / min", value: Binding(
                        get: { prefs.rateDeepgramNova3 },
                        set: { prefs.rateDeepgramNova3 = $0 }))
                    rateField(title: "Deepgram Nova-2 / min", value: Binding(
                        get: { prefs.rateDeepgramNova2 },
                        set: { prefs.rateDeepgramNova2 = $0 }))
                    rateField(title: "OpenAI mini-transcribe / min", value: Binding(
                        get: { prefs.rateOpenAIMiniTranscribe },
                        set: { prefs.rateOpenAIMiniTranscribe = $0 }))
                    rateField(title: "OpenAI gpt-4o transcribe / min", value: Binding(
                        get: { prefs.rateOpenAITranscribe },
                        set: { prefs.rateOpenAITranscribe = $0 }))
                    rateField(title: "OpenAI whisper-1 / min", value: Binding(
                        get: { prefs.rateOpenAIWhisper },
                        set: { prefs.rateOpenAIWhisper = $0 }))
                    rateField(title: "Cleanup input / 1M tokens", value: Binding(
                        get: { prefs.rateCleanupInputPer1M },
                        set: { prefs.rateCleanupInputPer1M = $0 }))
                    rateField(title: "Cleanup output / 1M tokens", value: Binding(
                        get: { prefs.rateCleanupOutputPer1M },
                        set: { prefs.rateCleanupOutputPer1M = $0 }))
                }
            }
            .formStyle(.grouped)
        }
        .padding()
    }

    @ViewBuilder
    private func row(provider: String, label: String, model: String) -> some View {
        let rollup = usage.rollup(provider: provider, window: window)
        let cost = usage.cost(for: rollup, provider: provider, model: model, preferences: prefs)
        let minutes = rollup.totalAudioSeconds / 60.0
        HStack {
            Text(label).frame(width: 220, alignment: .leading)
            Text("\(rollup.transcriptionCount) transcriptions")
                .foregroundColor(.secondary)
                .frame(width: 160, alignment: .leading)
            Text(String(format: "%.1f min", minutes))
                .foregroundColor(.secondary)
                .frame(width: 80, alignment: .trailing)
            Spacer()
            Text(String(format: "$%.3f", cost))
                .font(.system(.body, design: .monospaced))
        }
    }

    @ViewBuilder
    private func rateField(title: String, value: Binding<Double>) -> some View {
        HStack {
            Text(title)
            Spacer()
            TextField("", value: value, formatter: Self.rateFormatter)
                .frame(width: 90)
                .multilineTextAlignment(.trailing)
        }
    }

    private static let rateFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 6
        return f
    }()
}

// MARK: - About

struct AboutSettingsView: View {
    @EnvironmentObject var env: AppEnvironment

    var body: some View {
        VStack(spacing: 16) {
            Image("AppIcon")
                .resizable().aspectRatio(contentMode: .fit)
                .frame(width: 96, height: 96)
            Text("Speakist").font(.title.weight(.semibold))
            if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
                Text("Version \(version)").foregroundColor(.secondary)
            }
            Button("Check for updates…") {
                env.updater.checkForUpdates()
            }
            Divider()
            Text("Speakist keeps your data local. Audio and history live in Application Support. API keys live in the Keychain. Nothing is sent anywhere except the STT and optional cleanup endpoints you configured.")
                .font(.footnote)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
        .frame(maxWidth: .infinity)
    }
}
