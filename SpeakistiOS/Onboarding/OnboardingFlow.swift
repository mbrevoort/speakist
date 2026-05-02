import SwiftUI
import AVFoundation
import UIKit

/// First-launch walk-through. Five panes, ordered so each step unblocks
/// the next:
///
///   1. Welcome — what Speakist does.
///   2. Sign in — device-code flow against the Speakist backend.
///   3. Microphone — triggers iOS permission dialog.
///   4. Enable Keyboard — deep-links into Settings so user adds
///      "Speakist" under Keyboards, then toggles Allow Full Access.
///   5. Try it — mini demo that activates a session so the user learns
///      the swipe-right gesture before hitting it in the wild.
///
/// The scaffold implements the page chrome and wires the permission
/// prompt; the sign-in panel is a placeholder until the API client + URL
/// opener are ported over from the Mac app.
struct OnboardingFlow: View {
    let onComplete: () -> Void

    // Use @SceneStorage so the page index survives the round-trip
    // through Settings.app — the EnableKeyboardPane deep-links into
    // Settings via UIApplication.openSettingsURLString, and on return
    // SwiftUI recreates this view's hierarchy, which resets plain
    // @State. With SceneStorage we land back on the same step the
    // user was reading when they left, instead of jumping back to
    // the Welcome pane and looking like progress was lost. Keyed
    // under "onboardingPage" so a future migration to a different
    // onboarding flow can drop the key cleanly. Once
    // `onboardingCompleted` flips, RootView stops rendering this view
    // entirely so the stored page doesn't leak into any future
    // re-onboarding (it'd just start fresh at 0 if the user signs
    // out and back in).
    @SceneStorage("onboardingPage") private var page = 0
    private let pageCount = 5

    var body: some View {
        VStack {
            TabView(selection: $page) {
                WelcomePane().tag(0)
                SignInPane().tag(1)
                MicPermissionPane().tag(2)
                EnableKeyboardPane().tag(3)
                TryItPane(onDone: onComplete).tag(4)
            }
            .tabViewStyle(.page(indexDisplayMode: .always))

            HStack {
                Button("Back") {
                    if page > 0 { page -= 1 }
                }
                .disabled(page == 0)
                Spacer()
                Button(page == pageCount - 1 ? "Finish" : "Next") {
                    if page < pageCount - 1 {
                        page += 1
                    } else {
                        onComplete()
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(.speakistPeach)
            }
            .padding()
        }
    }
}

private struct WelcomePane: View {
    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "waveform.circle.fill")
                .font(.system(size: 96))
                .foregroundStyle(.speakistPeach)
            Text("Speakist")
                .font(.system(size: 42, weight: .semibold, design: .serif))
            Text("Speak anywhere. We'll type.")
                .font(.title3)
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}

private struct SignInPane: View {
    @EnvironmentObject private var account: SpeakistAccountManager

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "person.crop.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(.speakistPeach)

            switch account.state {
            case .signedOut:
                signedOutView
            case .signingIn(let userCode, let url, _):
                signingInView(userCode: userCode, url: url)
            case .signedIn(let identity):
                signedInView(identity: identity)
            }

            if let err = account.lastError {
                Text(err)
                    .font(.footnote)
                    .foregroundStyle(.speakistCoral)
                    .multilineTextAlignment(.center)
                    .padding(.top, 4)
            }
        }
        .padding()
    }

    private var signedOutView: some View {
        VStack(spacing: 12) {
            Text("Sign in to Speakist")
                .font(.title2.weight(.semibold))
            Text("You'll approve this device in your browser.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Sign in") {
                Task { await account.startSignIn() }
            }
            .buttonStyle(.borderedProminent)
            .tint(.speakistPeach)
        }
    }

    private func signingInView(userCode: String, url: URL) -> some View {
        VStack(spacing: 12) {
            Text("Approve in your browser")
                .font(.title2.weight(.semibold))
            Text("Confirm this code is the one you see on the sign-in page:")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Text(userCode)
                .font(.system(size: 34, weight: .bold, design: .monospaced))
                .tracking(6)
                .padding(.vertical, 8)
            Button("Reopen browser") {
                UIApplication.shared.open(url)
            }
            .buttonStyle(.bordered)
            .tint(.speakistPeach)
            ProgressView()
                .padding(.top, 4)
        }
    }

    private func signedInView(identity: SpeakistAccountManager.Identity?) -> some View {
        VStack(spacing: 12) {
            Label("Signed in", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.speakistSage)
                .font(.title3.weight(.medium))
            if let identity {
                Text(identity.email)
                    .font(.body)
                    .foregroundStyle(.secondary)
            }
            Button("Sign out") {
                account.signOut()
            }
            .buttonStyle(.bordered)
            .tint(.speakistCoral)
        }
    }
}

private struct MicPermissionPane: View {
    @State private var granted: Bool = AVAudioApplication.shared.recordPermission == .granted

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "mic.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(.speakistPeach)
            Text("Microphone")
                .font(.title2.weight(.semibold))
            Text("Speakist records while your Speak Session is active. Audio is sent to our backend for transcription and the result is returned. Neither the audio nor the transcript is ever saved in the cloud — only on your device.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            if granted {
                Label("Microphone granted", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.speakistSage)
            } else {
                Button("Allow microphone") {
                    AVAudioApplication.requestRecordPermission { approved in
                        DispatchQueue.main.async { granted = approved }
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(.speakistPeach)
            }
        }
        .padding()
    }
}

private struct EnableKeyboardPane: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "keyboard")
                .font(.system(size: 72))
                .foregroundStyle(.speakistPeach)
            Text("Enable the keyboard")
                .font(.title2.weight(.semibold))
            Text("In Settings → General → Keyboard → Keyboards → Add New Keyboard, pick Speakist, then tap it again and turn on **Allow Full Access**.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            Button("Open Settings") {
                KeyboardSettingsHelper.openKeyboardSettings()
            }
            .buttonStyle(.borderedProminent)
            .tint(.speakistPeach)
        }
        .padding()
    }
}

private struct TryItPane: View {
    let onDone: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "hand.tap.fill")
                .font(.system(size: 72))
                .foregroundStyle(.speakistPeach)
            Text("Try it out")
                .font(.title2.weight(.semibold))
            Text("Tap **Speakist** on the keyboard whenever you want to dictate. We'll briefly show a listening screen — swipe right to return to your app and keep talking.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            Button("Start using Speakist") {
                onDone()
            }
            .buttonStyle(.borderedProminent)
            .tint(.speakistPeach)
        }
        .padding()
    }
}

enum KeyboardSettingsHelper {
    /// Open iOS Settings at the app's settings page. iOS doesn't expose
    /// a deep link to the keyboard list specifically (prefs:root=…
    /// worked once upon a time, then Apple killed it) — best we can do
    /// is land the user in our app's settings row where they can tap
    /// "Keyboards".
    static func openKeyboardSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}
