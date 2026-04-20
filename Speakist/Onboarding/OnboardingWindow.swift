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
        case 2: return keychain.hasKey(.refreshToken)
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
