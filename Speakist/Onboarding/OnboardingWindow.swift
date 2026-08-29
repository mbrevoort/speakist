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
        // 620 × 580: 580 fits the worst case (shortcut pane with
        // Globe selected → System Settings callout visible)
        // without squeezing the "Try it now" editor below its
        // 70pt minimum or shoving the green "Got it" check up
        // against the Back/Continue divider. Previous 500pt
        // height squeezed the shortcut pane noticeably.
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 620, height: 580),
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
    @EnvironmentObject var env: AppEnvironment

    let onFinish: () -> Void

    private static let lastStep = 4

    @State private var step: Int = 0
    @State private var shortcutBaseline: Int? = nil
    @State private var shortcutTried: Bool = false
    /// Bumped on every UserDefaults change so `canAdvance` re-reads
    /// the current KeyboardShortcuts binding. Needed because
    /// `KeyboardShortcuts.getShortcut(for:)` reads UserDefaults
    /// directly without publishing changes; without this nudge the
    /// Continue button stays at its last computed enabled/disabled
    /// state even if the user clears the shortcut in the recorder.
    @State private var shortcutNonce: Int = 0
    @State private var modelNonce: Int = 0

    var body: some View {
        VStack(spacing: 0) {
            // GeometryReader gives us the viewport size so we can
            // force the scrollable content to fill at least that
            // height. Panes that want to center vertically (like
            // WelcomePane) use Spacers + maxHeight: .infinity
            // internally, which only resolves to "fill the
            // viewport" if their parent claims that height —
            // ScrollView alone leaves vertical space unbounded.
            //
            // ScrollView itself is the safety net: panes whose
            // content overflows (notably the shortcut pane with
            // Globe selected and the System Settings callout
            // visible) scroll instead of squeezing intrinsic-size
            // children. The window height is sized for the worst
            // case to fit without scrolling.
            GeometryReader { viewport in
                ScrollView {
                    content
                        .frame(maxWidth: .infinity,
                               minHeight: viewport.size.height - 48,
                               alignment: .topLeading)
                        .padding(.top, 28)
                        .padding(.bottom, 20)
                        .padding(.horizontal, 32)
                }
            }
            Divider()
            controls
                .padding(14)
        }
        .frame(width: 620, height: 580)
        .onChange(of: step) { _, newStep in
            if newStep == 3 && shortcutBaseline == nil {
                shortcutBaseline = okTranscriptCount()
            }
        }
        .onReceive(env.historyStore.$entries) { entries in
            let count = entries.filter { $0.transcriptionStatus == "ok" }.count
            if let b = shortcutBaseline, count > b { shortcutTried = true }
        }
        .onReceive(NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification)) { _ in
            // Cheap nudge so `canAdvance` re-evaluates with the
            // current shortcut binding. The notification fires for
            // every defaults write — fine here because we're only
            // active during onboarding and the recomputation is
            // a single dictionary read.
            shortcutNonce &+= 1
        }
        .onReceive(env.parakeetModel.$state) { _ in modelNonce &+= 1 }
        .onReceive(env.qwenCleanupModel.$state) { _ in modelNonce &+= 1 }
    }

    private func okTranscriptCount() -> Int {
        env.historyStore.entries.filter { $0.transcriptionStatus == "ok" }.count
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case 0: WelcomePane()
        case 1: LocalSetupPane()
        case 2: PermissionsPane()
        case 3: ShortcutTryPane(tried: shortcutTried)
        case 4: LaunchPane()
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
        case 1:
            _ = modelNonce
            return env.parakeetModel.state.isReady
                && env.qwenCleanupModel.state.isReady
        case 2:
            return permissions.mic == .granted
                && permissions.accessibility == .granted
        case 3:
            // Always advanceable in Globe mode (the binding *is*
            // the Globe key — can't be unset). In custom-shortcut
            // mode, only block when the user has cleared the
            // binding entirely so there's literally no shortcut
            // assigned. Touch `shortcutNonce` so the recompute
            // tracks UserDefaults writes from the recorder.
            _ = shortcutNonce
            if prefs.useGlobeKey { return true }
            return KeyboardShortcuts.getShortcut(for: .pushToTalk) != nil
        default: return true
        }
    }
}

private struct WelcomePane: View {
    var body: some View {
        // Spacers + maxHeight: .infinity vertically center the
        // microphone + welcome text. Resolves correctly because
        // OnboardingView's GeometryReader gives the content a
        // minHeight matching the viewport, so this pane claims
        // the full visible space rather than collapsing to
        // intrinsic content height inside the ScrollView.
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "mic.fill")
                .resizable().aspectRatio(contentMode: .fit)
                .frame(width: 68, height: 68)
                .foregroundColor(.speakistPeach)
            Text("Welcome to Speakist").font(.title.weight(.semibold))
            Text("Hold a shortcut, speak, release — polished text appears at your cursor in any app.\nYour recordings and transcripts never leave your Mac.")
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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

private struct LocalSetupPane: View {
    @EnvironmentObject var env: AppEnvironment

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Set up on-device dictation").font(.title2.weight(.semibold))
            Text("Speakist uses two models on your Mac: one turns English speech into text, and one cleans up punctuation and grammar. There is no account and your recordings, transcripts, and vocabulary are never uploaded.")
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            LocalModelsSetupPane(
                speechToText: env.parakeetModel,
                languageModel: env.qwenCleanupModel)

            Spacer(minLength: 0)
        }
        .task {
            env.transcriptionService.prepareModelsInBackground()
        }
    }
}

private struct LocalModelsSetupPane: View {
    private enum SetupState {
        case notInstalled
        case preparing(Double, String)
        case ready
        case failed(String)
    }

    @ObservedObject var speechToText: ParakeetModelManager
    @ObservedObject var languageModel: QwenCleanupModelManager

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            modelRow(
                title: "Speech-to-text model",
                detail: "About 1.1 GB · English speech recognition",
                state: setupState(speechToText.state)) {
                speechToText.prepareInBackground()
            }

            modelRow(
                title: "Large language model",
                detail: "About 290 MB · guarded punctuation and grammar cleanup",
                state: setupState(languageModel.state)) {
                languageModel.prepareInBackground()
            }

            Text("The downloads start automatically and happen once. Keep Speakist open and connected; after setup, dictation works offline.")
                .font(.caption)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.08)))
    }

    @ViewBuilder
    private func modelRow(title: String,
                          detail: String,
                          state: SetupState,
                          retry: @escaping () -> Void) -> some View {
        switch state {
        case .notInstalled:
            VStack(alignment: .leading, spacing: 4) {
                Label("Preparing \(title.lowercased())…", systemImage: "arrow.down.circle")
                Text(detail).font(.caption).foregroundColor(.secondary)
            }
        case .preparing(let progress, let phase):
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.callout.weight(.medium))
                ProgressView(value: progress)
                Text(progress > 0 && progress < 1
                     ? "\(Int(progress * 100))% · \(phase)"
                     : phase)
                    .font(.caption)
                    .foregroundColor(.secondary)
                Text(detail).font(.caption2).foregroundColor(.secondary)
            }
        case .ready:
            Label("\(title) is ready", systemImage: "checkmark.circle.fill")
                .foregroundColor(.speakistSage)
        case .failed(let message):
            VStack(alignment: .leading, spacing: 5) {
                Label("\(title) setup failed", systemImage: "exclamationmark.triangle.fill")
                    .foregroundColor(.red)
                Text(message).font(.caption).foregroundColor(.secondary)
                    .textSelection(.enabled)
                Text("Check your connection and available disk space, then retry. Already-downloaded files are reused.")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Try again", action: retry)
            }
        }
    }

    private func setupState(_ state: ParakeetModelManager.State) -> SetupState {
        switch state {
        case .notInstalled: return .notInstalled
        case .preparing(let progress, let phase): return .preparing(progress, phase)
        case .ready: return .ready
        case .failed(let message): return .failed(message)
        }
    }

    private func setupState(_ state: QwenCleanupModelManager.State) -> SetupState {
        switch state {
        case .notInstalled: return .notInstalled
        case .preparing(let progress, let phase): return .preparing(progress, phase)
        case .ready: return .ready
        case .failed(let message): return .failed(message)
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
            Text("Hold the shortcut anywhere on your Mac, speak, and release. The transcript appears at your cursor. Change the shortcut if the default clashes with another app or you prefer a different key combination.")
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

private struct LaunchPane: View {
    @EnvironmentObject var prefs: Preferences

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: "power.circle.fill")
                .resizable().aspectRatio(contentMode: .fit)
                .frame(width: 68, height: 68)
                .foregroundColor(.speakistPeach)
            Text("Start Speakist at login?").font(.title2.weight(.semibold))
            Text("Speakist stays available from the menu bar and the Dock. Launching at login keeps your dictation shortcut ready whenever you log in to your Mac.")
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)
                .frame(maxWidth: 440)

            Toggle("Launch Speakist at login", isOn: Binding(
                get: { prefs.launchAtLogin },
                set: { prefs.launchAtLogin = $0 }))

            Text("You're ready. Hold your shortcut anywhere on your Mac to dictate.")
                .foregroundColor(.secondary)
                .padding(.top, 8)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
