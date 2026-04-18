import SwiftUI
import AppKit
import AVFoundation

@MainActor
final class OnboardingWindowController: NSWindowController, NSWindowDelegate {
    private let env: AppEnvironment
    private let onFinish: () -> Void

    init(env: AppEnvironment, onFinish: @escaping () -> Void) {
        self.env = env
        self.onFinish = onFinish
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 620, height: 440),
            styleMask: [.titled, .closable],
            backing: .buffered, defer: false)
        window.title = "Welcome to Speakist"
        window.center()
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self
        let view = OnboardingView(onFinish: onFinish)
            .environmentObject(env.preferences)
            .environmentObject(env.permissions)
            .environmentObject(env.keychain)
            .environmentObject(env)
        window.contentView = NSHostingView(rootView: view)
    }

    required init?(coder: NSCoder) { fatalError() }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        showWindow(nil)
    }
}

struct OnboardingView: View {
    @EnvironmentObject var prefs: Preferences
    @EnvironmentObject var permissions: PermissionCoordinator
    @EnvironmentObject var keychain: KeychainStore
    @EnvironmentObject var env: AppEnvironment

    let onFinish: () -> Void

    @State private var step: Int = 0

    var body: some View {
        VStack(spacing: 0) {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.top, 28)
                .padding(.horizontal, 32)
            Divider()
            controls
                .padding(14)
        }
        .frame(width: 620, height: 440)
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case 0: WelcomePane()
        case 1: PermissionsPane()
        case 2: ProviderPane()
        case 3: LaunchPane()
        default: EmptyView()
        }
    }

    private var controls: some View {
        HStack {
            if step > 0 {
                Button("Back") { step -= 1 }
            }
            Spacer()
            if step < 3 {
                Button("Continue") { step += 1 }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canAdvance)
            } else {
                Button("Done") { onFinish() }
                    .keyboardShortcut(.defaultAction)
            }
        }
    }

    private var canAdvance: Bool {
        switch step {
        case 1: return permissions.mic == .granted && permissions.accessibility == .granted
        case 2: return keychain.hasKey(.deepgram) || keychain.hasKey(.openai)
        default: return true
        }
    }
}

private struct WelcomePane: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "mic.fill")
                .resizable().aspectRatio(contentMode: .fit)
                .frame(width: 68, height: 68)
                .foregroundColor(.speakistPeach)
            Text("Welcome to Speakist").font(.title.weight(.semibold))
            Text("Hold a shortcut, speak, release — text appears at your cursor in any app.\nCorrect a transcription once, and Speakist remembers it the next time.")
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct PermissionsPane: View {
    @EnvironmentObject var permissions: PermissionCoordinator

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Grant permissions").font(.title2.weight(.semibold))
            Text("Speakist needs two permissions to work. Both are local — nothing is sent off-device by granting them.")
                .foregroundColor(.secondary)

            permissionRow(
                icon: "mic",
                title: "Microphone",
                body: "Captures your voice when you hold the dictation shortcut.",
                state: permissions.mic,
                action: {
                    Task { _ = await permissions.requestMicrophone() }
                },
                settingsAction: permissions.openMicrophoneSettings)

            permissionRow(
                icon: "keyboard",
                title: "Accessibility",
                body: "Lets Speakist paste your transcript at the cursor in any app.",
                state: permissions.accessibility,
                action: { _ = permissions.promptAccessibility() },
                settingsAction: permissions.openAccessibilitySettings)
        }
    }

    @ViewBuilder
    private func permissionRow(icon: String,
                               title: String,
                               body: String,
                               state: PermissionState,
                               action: @escaping () -> Void,
                               settingsAction: @escaping () -> Void) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(.title2)
                .frame(width: 32)
                .foregroundColor(.speakistPeach)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(body).font(.callout).foregroundColor(.secondary)
            }
            Spacer()
            VStack(spacing: 6) {
                switch state {
                case .granted:
                    Label("Granted", systemImage: "checkmark.circle.fill")
                        .foregroundColor(.speakistSage)
                case .notDetermined:
                    Button("Grant") { action() }
                case .denied:
                    Button("Open Settings") { settingsAction() }
                }
            }
            .frame(width: 140, alignment: .trailing)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.08)))
    }
}

private struct ProviderPane: View {
    @EnvironmentObject var prefs: Preferences
    @EnvironmentObject var keychain: KeychainStore
    @EnvironmentObject var env: AppEnvironment

    @State private var deepgramKey = ""
    @State private var openaiKey = ""
    @State private var testing = false
    @State private var testResult = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Connect a transcription provider").font(.title2.weight(.semibold))
            Text("Speakist uses cloud STT. Paste a Deepgram or OpenAI API key — Speakist stores it in your Keychain.")
                .foregroundColor(.secondary)

            Form {
                Picker("Active provider", selection: Binding(
                    get: { prefs.activeProvider },
                    set: { prefs.activeProvider = $0 })) {
                    ForEach(TranscriptionProvider.allCases) { p in
                        Text(p.displayName).tag(p)
                    }
                }
                .pickerStyle(.segmented)

                SecureField("Deepgram API key", text: $deepgramKey)
                    .onSubmit { keychain.set(deepgramKey, for: .deepgram) }
                SecureField("OpenAI API key (also used for cleanup)", text: $openaiKey)
                    .onSubmit { keychain.set(openaiKey, for: .openai) }
                HStack {
                    Button("Save keys") {
                        keychain.set(deepgramKey, for: .deepgram)
                        keychain.set(openaiKey, for: .openai)
                    }
                    Button(testing ? "Testing…" : "Test recording (2 s)") {
                        Task { await runTest() }
                    }
                    .disabled(testing)
                }
                if !testResult.isEmpty {
                    Text(testResult).font(.callout).foregroundColor(.secondary)
                }
            }
            .formStyle(.grouped)
        }
        .onAppear {
            deepgramKey = keychain.get(.deepgram) ?? ""
            openaiKey = keychain.get(.openai) ?? ""
        }
    }

    private func runTest() async {
        testing = true; defer { testing = false }
        testResult = "Recording for 2 seconds…"
        do {
            try env.audioRecorder.start()
        } catch {
            testResult = "Start failed: \(error.localizedDescription)"
            return
        }
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        guard let rec = env.audioRecorder.stop() else {
            testResult = "No audio captured."
            return
        }
        testResult = "Transcribing…"
        let client: TranscriptionClient?
        switch prefs.activeProvider {
        case .deepgram:
            if let k = keychain.get(.deepgram), !k.isEmpty {
                client = DeepgramClient(apiKey: k, model: prefs.deepgramModel)
            } else { client = nil }
        case .openai:
            if let k = keychain.get(.openai), !k.isEmpty {
                client = OpenAITranscribeClient(apiKey: k, model: prefs.openaiTranscribeModel)
            } else { client = nil }
        }
        guard let client else {
            testResult = "No API key for \(prefs.activeProvider.displayName)."
            return
        }
        do {
            let r = try await client.transcribe(audioURL: rec.url, keyterms: [], language: "en")
            testResult = r.text.isEmpty ? "Empty transcript (try speaking next time)." : "✓ \(r.text)"
        } catch {
            testResult = "Error: \(error.localizedDescription)"
        }
        try? FileManager.default.removeItem(at: rec.url)
    }
}

private struct LaunchPane: View {
    @EnvironmentObject var prefs: Preferences

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "power.circle.fill")
                .resizable().aspectRatio(contentMode: .fit)
                .frame(width: 68, height: 68)
                .foregroundColor(.speakistPeach)
            Text("Start Speakist at login?").font(.title2.weight(.semibold))
            Text("Speakist runs in your menu bar only, no Dock icon. Launching at login keeps your shortcut always available.")
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)
                .frame(maxWidth: 440)

            Toggle("Launch Speakist at login", isOn: Binding(
                get: { prefs.launchAtLogin },
                set: { prefs.launchAtLogin = $0 }))

            Text("You're ready. Try ⌃⌘X anywhere on your Mac.")
                .foregroundColor(.secondary)
                .padding(.top, 8)
        }
    }
}
