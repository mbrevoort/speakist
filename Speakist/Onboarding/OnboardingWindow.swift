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
    /// Drives auto-focus on the test-it-now editor when the pane
    /// first appears. Stored as @FocusState so SwiftUI manages the
    /// first-responder dance with the NSHostingView wrapper.
    @FocusState private var demoFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Set your shortcut").font(.title2.weight(.semibold))
            Text("Hold the shortcut anywhere on your Mac, speak, and release. The transcript appears at your cursor. Change the combo here if the default clashes with another app.")
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                Image(systemName: prefs.useGlobeKey ? "globe" : "keyboard")
                    .foregroundColor(.speakistPeach)
                    .frame(width: 24)
                Text("Hold to record")
                Spacer()
                ShortcutPickerPills()
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.08)))

            if prefs.useGlobeKey {
                ShortcutGlobeCallout()
                    .transition(.opacity.combined(with: .move(edge: .top)))
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
                .focused($demoFocused)

            if tried {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.speakistSage)
                    Text("Got it — shortcut works.")
                        .font(.callout.weight(.medium))
                }
            }
        }
        // Animate the callout's appearance/dismissal so toggling
        // the shortcut mode doesn't jolt the layout. Bound to the
        // toggle state itself so SwiftUI only animates when that
        // flips — unrelated state changes (typing in the test
        // field, the `tried` flag flipping) aren't affected.
        .animation(.easeInOut(duration: 0.18), value: prefs.useGlobeKey)
        // First-responder dance: NSHostingView and the surrounding
        // window need a moment to install before SwiftUI's focus
        // request will land. A 60ms delay is enough on every Mac
        // we've tested without being visible to the user — the
        // cursor blink is already in the editor by the time their
        // eyes have parsed "Try it now."
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) {
                demoFocused = true
            }
        }
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
