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
            if newStep == 4 && polishBaseline == nil {
                polishBaseline = okTranscriptCount()
            }
        }
        .onReceive(env.historyStore.$entries) { entries in
            let count = entries.filter { $0.transcriptionStatus == "ok" }.count
            if let b = shortcutBaseline, count > b { shortcutTried = true }
            if let b = polishBaseline, count > b { polishTried = true }
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
        case 2:
            if prefs.transcriptionEngine == .parakeet {
                _ = modelNonce
                // Parakeet is the only required local asset. Qwen is an
                // optional presentation pass: deterministic cleanup remains
                // available while it downloads or after a failure.
                return env.parakeetModel.state.isReady
            }
            return keychain.hasKey(.refreshToken)
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
        case 4:
            // Polish is opt-in and reversible from Settings. Don't
            // force the user to flip the toggle or test it during
            // onboarding — `polishTried` still drives the "got it"
            // affordance inside the pane but no longer gates
            // advance.
            return true
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
            Text("Hold a shortcut, speak, release — text appears at your cursor in any app.\nCorrect a transcription once, and Speakist remembers it the next time.")
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

private struct ProviderPane: View {
    @EnvironmentObject var prefs: Preferences
    @EnvironmentObject var env: AppEnvironment
    @EnvironmentObject var manager: SpeakistAccountManager

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Choose transcription").font(.title2.weight(.semibold))
            Text("The recommended local stack runs privately on this Mac and needs no account. Speakist Cloud remains available for multilingual transcription, synced vocabulary, and optional cloud polish.")
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Picker("Engine", selection: Binding(
                get: { prefs.transcriptionEngine },
                set: { prefs.transcriptionEngine = $0 })) {
                ForEach(TranscriptionEngine.allCases) { engine in
                    Text(engine.displayName).tag(engine)
                }
            }
            .pickerStyle(.radioGroup)

            Text(prefs.transcriptionEngine.detail)
                .font(.callout)
                .foregroundColor(.secondary)

            if prefs.transcriptionEngine == .parakeet {
                LocalModelsSetupPane(parakeet: env.parakeetModel,
                                     qwen: env.qwenCleanupModel,
                                     cleanupMode: Binding(
                                        get: { prefs.localCleanupMode },
                                        set: { prefs.localCleanupMode = $0 }))
            } else {
                cloudSignIn
            }

            Spacer(minLength: 0)
        }
        .task(id: prefs.transcriptionEngine) {
            if prefs.transcriptionEngine == .parakeet {
                env.parakeetModel.prepareInBackground()
                if prefs.localCleanupMode == .qwenExperimental {
                    env.qwenCleanupModel.prepareInBackground()
                }
            } else {
                await env.correctionStore.syncFromServer(api: env.apiClient)
            }
        }
        .onChange(of: prefs.localCleanupMode) { _, mode in
            if prefs.transcriptionEngine == .parakeet,
               mode == .qwenExperimental {
                env.qwenCleanupModel.prepareInBackground()
            }
        }
    }

    @ViewBuilder
    private var cloudSignIn: some View {
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
            Label("Signed in and ready for cloud transcription", systemImage: "checkmark.circle.fill")
                .foregroundColor(.speakistSage)
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

    @ObservedObject var parakeet: ParakeetModelManager
    @ObservedObject var qwen: QwenCleanupModelManager
    @Binding var cleanupMode: LocalCleanupMode

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            modelRow(
                title: "Parakeet transcription",
                detail: "Required · about 1.1 GB · English speech recognition",
                state: setupState(parakeet.state)) {
                parakeet.prepareInBackground()
            }

            Picker("Transcript cleanup", selection: $cleanupMode) {
                ForEach(LocalCleanupMode.allCases) { mode in
                    Text(mode.displayName).tag(mode)
                }
            }
            .pickerStyle(.menu)

            if cleanupMode == .qwenExperimental {
                modelRow(
                    title: "Local AI cleanup",
                    detail: "Optional · about 290 MB · guarded punctuation and presentation",
                    state: setupState(qwen.state),
                    useRulesInstead: {
                        cleanupMode = .deterministic
                    }) {
                    qwen.prepareInBackground()
                }
            }

            if parakeet.state.isReady,
               cleanupMode == .qwenExperimental,
               !qwen.state.isReady {
                Label(
                    "You can continue now. Rules-only cleanup will be used until the optional AI model is ready.",
                    systemImage: "checkmark.shield")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Downloads happen once and are cached on this Mac. Keep Speakist open and connected; afterward the selected local stack works offline.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.08)))
    }

    @ViewBuilder
    private func modelRow(title: String,
                          detail: String,
                          state: SetupState,
                          useRulesInstead: (() -> Void)? = nil,
                          retry: @escaping () -> Void) -> some View {
        switch state {
        case .notInstalled:
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Label(title, systemImage: "arrow.down.circle")
                    Spacer()
                    Button("Download", action: retry)
                }
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
                HStack {
                    Button("Try again", action: retry)
                    if let useRulesInstead {
                        Button("Use rules only", action: useRulesInstead)
                    }
                }
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
            Text(prefs.transcriptionEngine == .parakeet
                 ? "Parakeet transcribes on this Mac. Exact vocabulary replacements, speech cleanup, and the guarded local AI presentation pass also stay on this Mac."
                 : "When polish is on, each transcript is tidied up — punctuation added, capitalization fixed, clear grammar slips corrected.")
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if prefs.transcriptionEngine == .cloud {
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
            } else {
                Label(prefs.localCleanupMode.displayName, systemImage: "checkmark.shield.fill")
                    .foregroundColor(.speakistSage)
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.08)))
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(prefs.transcriptionEngine == .parakeet
                     ? "Try another local dictation"
                     : (prefs.polishEnabled ? "One more dictation" : "Turn it on, then dictate once more"))
                    .font(.headline)
                Text(prefs.transcriptionEngine == .parakeet
                     ? "Hold your shortcut, speak, and release. The audio will be transcribed without leaving your Mac."
                     : "Hold your shortcut and say a sentence with a couple of \u{201C}ums\u{201D} or a run-on thought. Polish will clean it up.")
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
                    Text(prefs.transcriptionEngine == .parakeet
                         ? "Done — that transcription stayed local."
                         : (prefs.polishEnabled ? "Nice — polish is on and applied." : "Done. Flip polish on above if you'd like it applied going forward."))
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
            Text("Speakist stays available from the menu bar and the Dock. Launching at login keeps your dictation shortcut ready whenever you sign in.")
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
