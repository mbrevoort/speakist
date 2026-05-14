import SwiftUI
import AppKit
import AVFoundation
import KeyboardShortcuts

@MainActor
final class OnboardingWindowController: NSWindowController, NSWindowDelegate {
    private let env: AppEnvironment
    private let onFinish: () -> Void

    init(env: AppEnvironment, onFinish: @escaping () -> Void) {
        self.env = env
        self.onFinish = onFinish
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 620, height: 500),
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
            .environmentObject(env.accountManager)
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

    private static let lastStep = 5

    @State private var step: Int = 0
    @State private var shortcutBaseline: Int? = nil
    @State private var shortcutTried: Bool = false
    @State private var polishBaseline: Int? = nil
    @State private var polishTried: Bool = false
    @State private var polishSaving: Bool = false
    @State private var polishError: String? = nil

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
        .frame(width: 620, height: 500)
        .onChange(of: step) { _, newStep in
            if newStep == 3 && shortcutBaseline == nil {
                shortcutBaseline = okTranscriptCount()
            }
            if newStep == 4 && polishBaseline == nil {
                polishBaseline = okTranscriptCount()
            }
        }
        .onReceive(env.historyStore.$entries) { entries in
            let count = entries.filter { $0.transcriptionStatus == "ok" }.count
            if let b = shortcutBaseline, count > b { shortcutTried = true }
            if let b = polishBaseline, count > b { polishTried = true }
        }
    }

    private func okTranscriptCount() -> Int {
        env.historyStore.entries.filter { $0.transcriptionStatus == "ok" }.count
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case 0: WelcomePane()
        case 1: PermissionsPane()
        case 2: ProviderPane()
        case 3: ShortcutTryPane(tried: shortcutTried)
        case 4: PolishTryPane(tried: polishTried,
                              saving: $polishSaving,
                              errorMessage: $polishError)
        case 5: LaunchPane()
        default: EmptyView()
        }
    }

    private var controls: some View {
        HStack {
            if step > 0 {
                Button("Back") { step -= 1 }
            }
            Spacer()
            if step < Self.lastStep {
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
        case 2: return keychain.hasKey(.refreshToken)
        case 3: return shortcutTried
        case 4: return polishTried
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
    @EnvironmentObject var env: AppEnvironment
    @EnvironmentObject var manager: SpeakistAccountManager

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Sign in to Speakist").font(.title2.weight(.semibold))
            Text("Your Speakist account handles transcription billing and syncs your vocabulary across Macs. New accounts start with $5 in free credit — no card required.")
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            switch manager.state {
            case .signedOut:
                VStack(alignment: .leading, spacing: 12) {
                    Button {
                        Task { await manager.startSignIn() }
                    } label: {
                        Label("Sign in with Speakist", systemImage: "person.crop.circle.badge.checkmark")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    if let err = manager.lastError {
                        Text(err).font(.callout).foregroundColor(.red)
                    }
                }

            case .signingIn(let code, let url, _):
                VStack(alignment: .leading, spacing: 10) {
                    Text("Your browser should have opened. Enter this code on the web:")
                        .font(.callout)
                        .foregroundColor(.secondary)
                    Text(code)
                        .font(.system(size: 24, weight: .semibold, design: .monospaced))
                        .kerning(3)
                    HStack {
                        Button("Copy code") {
                            let pb = NSPasteboard.general
                            pb.clearContents()
                            pb.setString(code, forType: .string)
                        }
                        Button("Open link again") { NSWorkspace.shared.open(url) }
                    }
                }

            case .signedIn:
                HStack(spacing: 10) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title2)
                        .foregroundColor(.speakistSage)
                    VStack(alignment: .leading) {
                        Text("Signed in").font(.headline)
                        Text("You can finish onboarding — transcriptions will bill against your Speakist credit.")
                            .font(.callout)
                            .foregroundColor(.secondary)
                    }
                }
            }

            Spacer(minLength: 0)

            Text("Using API endpoint: \(prefs.apiBaseURL.absoluteString)")
                .font(.caption2)
                .foregroundColor(.secondary)
        }
    }
}

private struct ShortcutTryPane: View {
    @EnvironmentObject var prefs: Preferences

    let tried: Bool

    @State private var demoText: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Set your shortcut").font(.title2.weight(.semibold))
            Text("Hold the shortcut anywhere on your Mac, speak, and release. The transcript appears at your cursor. Change the combo here if the default clashes with another app.")
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            shortcutCard

            // Globe key is offered as a side option rather than a
            // peer to the recorder. Onboarding's first goal is to
            // get the user past the "what is my shortcut" decision
            // with as little friction as possible — most users will
            // accept the default key combo, so we don't put Globe
            // in their face. A single subtle link makes it
            // discoverable for users who came from Wispr or want a
            // single-key feel. When chosen, the rest of the flow
            // (System Settings hint, etc.) appears in-place inside
            // `globeSelectedCallout`.
            if !prefs.useGlobeKey {
                Button {
                    prefs.useGlobeKey = true
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "globe")
                        Text("Use the Globe (🌐) key instead")
                    }
                }
                .buttonStyle(.link)
                .font(.callout)
            } else {
                globeSelectedCallout
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Try it now").font(.headline)
                Text("Click into the field below, hold your shortcut, say a short sentence, and release.")
                    .font(.callout)
                    .foregroundColor(.secondary)
            }

            TextEditor(text: $demoText)
                .font(.body)
                .frame(minHeight: 70)
                .padding(6)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color.secondary.opacity(0.35), lineWidth: 1)
                )

            if tried {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.speakistSage)
                    Text("Got it — shortcut works.")
                        .font(.callout.weight(.medium))
                }
            }
        }
    }

    /// The "Hold to record" card — either the KeyboardShortcuts
    /// recorder for a key combo, or a read-only Globe badge when
    /// the user opted into the Globe key path.
    @ViewBuilder private var shortcutCard: some View {
        HStack {
            Image(systemName: prefs.useGlobeKey ? "globe" : "keyboard")
                .foregroundColor(.speakistPeach)
                .frame(width: 24)
            Text("Hold to record")
            Spacer()
            if prefs.useGlobeKey {
                Text("🌐  Globe")
                    .font(.system(.body, design: .monospaced))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.15)))
            } else {
                KeyboardShortcuts.Recorder(for: .pushToTalk)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.08)))
    }

    /// Shown only after the user picks Globe. Two jobs:
    ///  1. Surface the *one* macOS setting the Globe key needs
    ///     (otherwise the OS grabs the key for Character Viewer
    ///     before Speakist sees it). Without this step Globe just
    ///     looks broken.
    ///  2. Offer a one-click escape back to the key-combo flow if
    ///     the user changes their mind.
    @ViewBuilder private var globeSelectedCallout: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "info.circle.fill")
                    .foregroundColor(.speakistMustard)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 4) {
                    Text("One quick macOS setting")
                        .font(.callout.weight(.semibold))
                    Text("So macOS doesn't grab the Globe key first: open Keyboard settings and set \u{201C}Press 🌐 key to\u{201D} to \u{201C}Do Nothing\u{201D}.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Open Keyboard Settings") {
                        Self.openKeyboardSettings()
                    }
                    .buttonStyle(.link)
                    .font(.footnote)
                    .padding(.top, 2)
                }
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.speakistMustard.opacity(0.10)))

            Button("Use a key combo instead") {
                prefs.useGlobeKey = false
            }
            .buttonStyle(.link)
            .font(.callout)
        }
    }

    /// Open System Settings → Keyboard. Tries the modern Ventura+
    /// scheme first, falls back to the legacy preference pane URL.
    /// Either lands the user on the Keyboard pane where the
    /// "Press 🌐 key to" picker lives near the top.
    private static func openKeyboardSettings() {
        let modern = URL(string: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension")
        let legacy = URL(string: "x-apple.systempreferences:com.apple.preference.keyboard")
        if let url = modern, NSWorkspace.shared.open(url) { return }
        if let url = legacy { NSWorkspace.shared.open(url) }
    }
}

private struct PolishTryPane: View {
    @EnvironmentObject var prefs: Preferences
    @EnvironmentObject var env: AppEnvironment

    let tried: Bool
    @Binding var saving: Bool
    @Binding var errorMessage: String?

    @State private var demoText: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Polish your transcripts").font(.title2.weight(.semibold))
            Text("When polish is on, each transcript is tidied up — punctuation added, capitalization fixed, clear grammar slips corrected.")
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Toggle(isOn: Binding(
                get: { prefs.polishEnabled },
                set: { savePolish($0) })) {
                HStack(spacing: 8) {
                    Image(systemName: "sparkles")
                        .foregroundColor(.speakistPeach)
                    Text("Polish each transcription")
                }
            }
            .disabled(saving)
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.08)))

            VStack(alignment: .leading, spacing: 6) {
                Text(prefs.polishEnabled ? "One more dictation" : "Turn it on, then dictate once more")
                    .font(.headline)
                Text("Hold your shortcut and say a sentence with a couple of \u{201C}ums\u{201D} or a run-on thought. Polish will clean it up.")
                    .font(.callout)
                    .foregroundColor(.secondary)
            }

            TextEditor(text: $demoText)
                .font(.body)
                .frame(minHeight: 70)
                .padding(6)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color.secondary.opacity(0.35), lineWidth: 1)
                )

            if tried {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.speakistSage)
                    Text(prefs.polishEnabled ? "Nice — polish is on and applied." : "Done. Flip polish on above if you'd like it applied going forward.")
                        .font(.callout.weight(.medium))
                }
            }

            if let err = errorMessage {
                Text(err).font(.footnote).foregroundColor(.red)
            }
        }
    }

    private func savePolish(_ newValue: Bool) {
        saving = true
        errorMessage = nil
        Task {
            defer { saving = false }
            do {
                let resp = try await env.apiClient.updatePolish(enabled: newValue, systemPrompt: nil)
                prefs.applyPolishFromServer(
                    enabled: resp.enabled,
                    mode: resp.mode,
                    systemPrompt: resp.systemPrompt,
                    isCustom: resp.isCustom,
                    defaultPrompt: resp.defaultPrompt)
            } catch {
                errorMessage = "Couldn't save: \(error.localizedDescription)"
            }
        }
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

            Text("You're ready. Hold your shortcut anywhere on your Mac to dictate.")
                .foregroundColor(.secondary)
                .padding(.top, 8)
        }
    }
}
