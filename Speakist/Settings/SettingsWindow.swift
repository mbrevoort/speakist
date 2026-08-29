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

// These settings detail views are mounted directly by `MainView`'s sidebar
// dispatcher. The earlier `SettingsWindow` wrapper + `SettingsSection`
// enum were removed when the standalone Settings window was folded
// into the unified main window.


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
                VStack(alignment: .leading, spacing: 4) {
                    Toggle("Mute other audio while dictating", isOn: Binding(
                        get: { prefs.muteAudioDuringDictation },
                        set: { prefs.muteAudioDuringDictation = $0 }))
                    Text("Silences music and videos while you speak, and brings them back when you're done. macOS will ask once for System Audio Recording access — Speakist uses it only to mute, never to record.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
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
                    ShortcutPickerPills()
                }
                Text("Hold the shortcut, speak, and release to transcribe.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                if prefs.useGlobeKey {
                    ShortcutGlobeCallout()
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .animation(.easeInOut(duration: 0.18), value: prefs.useGlobeKey)
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

struct LocalOnlyTranscriptionSettingsView: View {
    @EnvironmentObject var env: AppEnvironment

    @State private var testOutput = ""
    @State private var testing = false

    var body: some View {
        Form {
            Section("Private by design") {
                Label("Everything happens on this Mac", systemImage: "lock.shield.fill")
                    .foregroundColor(.speakistSage)
                Text("Your recordings, transcripts, vocabulary, and usage data are not sent to Speakist or an external transcription service. Internet access is only needed to download the models and app updates.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }

            Section("On-device models") {
                LocalModelStatusView(
                    title: "Speech-to-text model",
                    state: setupState(env.parakeetModel.state),
                    retry: env.parakeetModel.prepareInBackground)
                LocalModelStatusView(
                    title: "Large language model",
                    state: setupState(env.qwenCleanupModel.state),
                    retry: env.qwenCleanupModel.prepareInBackground)
                Text("Speakist downloads both models automatically. They are cached on this Mac and work offline after setup. Speech recognition currently supports English.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }

            Section("Diagnostics") {
                Button(testing ? "Recording…" : "Test recording (2 seconds)") {
                    Task { await runTestRecording() }
                }
                .disabled(testing
                          || env.permissions.mic != .granted
                          || !env.transcriptionService.modelsReady)
                if !testOutput.isEmpty {
                    Text(testOutput)
                        .font(.callout)
                        .foregroundColor(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .padding()
        .task {
            env.transcriptionService.prepareModelsInBackground()
        }
    }

    private func runTestRecording() async {
        testing = true
        testOutput = "Recording…"
        defer { testing = false }

        do {
            try await env.audioRecorder.start()
        } catch {
            testOutput = "Couldn't start: \(error.localizedDescription)"
            return
        }
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        guard let recording = env.audioRecorder.stop() else {
            testOutput = "No recording captured."
            return
        }

        testOutput = "Transcribing on this Mac…"
        do {
            let result = try await env.transcriptionService.transcribeForPreview(
                audioURL: recording.url)
            testOutput = result.text.isEmpty ? "(empty transcript)" : result.text
        } catch {
            testOutput = "Error: \(error.localizedDescription)"
        }
        try? FileManager.default.removeItem(at: recording.url)
    }

    private func setupState(_ state: ParakeetModelManager.State) -> LocalModelSetupState {
        switch state {
        case .notInstalled: return .notInstalled
        case .preparing(let progress, let phase): return .preparing(progress, phase)
        case .ready: return .ready
        case .failed(let message): return .failed(message)
        }
    }

    private func setupState(_ state: QwenCleanupModelManager.State) -> LocalModelSetupState {
        switch state {
        case .notInstalled: return .notInstalled
        case .preparing(let progress, let phase): return .preparing(progress, phase)
        case .ready: return .ready
        case .failed(let message): return .failed(message)
        }
    }
}

private enum LocalModelSetupState {
    case notInstalled
    case preparing(Double, String)
    case ready
    case failed(String)
}

private struct LocalModelStatusView: View {
    let title: String
    let state: LocalModelSetupState
    let retry: () -> Void

    var body: some View {
        switch state {
        case .notInstalled:
            Label("Preparing \(title.lowercased())…", systemImage: "arrow.down.circle")
                .foregroundColor(.secondary)
        case .preparing(let progress, let phase):
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.callout.weight(.medium))
                ProgressView(value: progress)
                Text(progress > 0 && progress < 1
                     ? "\(Int(progress * 100))% · \(phase)"
                     : phase)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        case .ready:
            Label("\(title) is ready", systemImage: "checkmark.circle.fill")
                .foregroundColor(.speakistSage)
        case .failed(let message):
            VStack(alignment: .leading, spacing: 6) {
                Label("\(title) setup failed", systemImage: "exclamationmark.triangle.fill")
                    .foregroundColor(.red)
                Text(message)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .textSelection(.enabled)
                Text("Check your internet connection and available disk space, then try again. Already-downloaded files will be reused.")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                Button("Try again", action: retry)
            }
        }
    }
}


// MARK: - Vocabulary

struct VocabularySettingsView: View {
    @EnvironmentObject var store: CorrectionStore
    @State private var newFrom = ""
    @State private var newTo = ""

    /// Hide staged corrections that have not been explicitly approved. A
    /// deliberately added rule is active immediately, while inline edits stay
    /// staged unless they are a safe spelling variant of an approved name.
    private var visibleEntries: [CorrectionRow] {
        store.all.filter { $0.appliesTo == .stt }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Vocabulary")
                    .font(.title3.weight(.semibold))
                Spacer()
            }
            Text("Words and phrases Speakist replaces after on-device transcription. Add proper nouns, preferred written forms, or terms Speakist consistently mishears. Similar spellings of an approved name can be learned from corrections you make in History.")
                .font(.footnote)
                .foregroundColor(.secondary)

            // Count and proper-noun metadata drive sorting and conservative
            // alias learning but are intentionally hidden from the user.
            Table(visibleEntries) {
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
                    // Manual additions are deliberate and become active local
                    // replacement rules immediately.
                    store.upsert(CorrectionRow(
                        dbID: nil,
                        fromText: f,
                        toText: t,
                        count: 1,
                        lastSeen: Date(),
                        isProperNoun: DiffEngine.isProperNounLike(t),
                        userManaged: true,
                        appliesTo: .stt))
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

                Text("Speech recognition and guarded language-model cleanup run on this Mac. Recordings, transcripts, vocabulary, history, and usage data are not sent to Speakist or an external transcription provider. The models download once and then work offline.")
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
                        // Speakist's marketing site, privacy policy,
                        // and terms of service all live on
                        // speakist.ai now. The pre-launch
                        // `brevoortstudio.com` URLs (and the matching
                        // `hello@brevoortstudio.com` address) were a
                        // placeholder from when the studio site
                        // fronted everything; the product domain
                        // is the canonical home.
                        Button("Website") {
                            if let url = URL(string: "https://speakist.ai") {
                                NSWorkspace.shared.open(url)
                            }
                        }
                        .buttonStyle(.link)
                        Button("Contact") {
                            if let url = URL(string: "mailto:hello@speakist.ai") {
                                NSWorkspace.shared.open(url)
                            }
                        }
                        .buttonStyle(.link)
                        Button("Privacy") {
                            if let url = URL(string: "https://speakist.ai/privacy") {
                                NSWorkspace.shared.open(url)
                            }
                        }
                        .buttonStyle(.link)
                        Button("Terms") {
                            if let url = URL(string: "https://speakist.ai/terms") {
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
