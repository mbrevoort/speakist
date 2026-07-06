import Foundation
import Combine

/// Dependency container. Lazily constructed and shared across the app.
@MainActor
final class AppEnvironment: ObservableObject {
    let preferences: Preferences
    let keychain: KeychainStore
    let permissions: PermissionCoordinator
    let deviceMonitor: DeviceMonitor
    let audioArchive: AudioArchive
    let historyStore: HistoryStore
    let correctionStore: CorrectionStore
    let usageTracker: UsageTracker
    let audioRecorder: AudioRecorder
    let cursorInserter: CursorInserter
    let focusedFieldProbe: FocusedFieldProbe
    let transcriptionService: TranscriptionService
    let hudController: HUDController
    let mediaPauser: MediaPauser
    let notifier: Notifier
    let updater: UpdaterController
    let accountManager: SpeakistAccountManager
    let apiClient: SpeakistAPIClient

    private var cancellables = Set<AnyCancellable>()

    init() {
        Logger.shared.bootstrap()
        let prefs = Preferences()
        self.preferences = prefs
        let keychain = KeychainStore()
        self.keychain = keychain
        self.permissions = PermissionCoordinator()
        self.deviceMonitor = DeviceMonitor()
        self.audioArchive = AudioArchive(preferences: prefs)
        self.historyStore = HistoryStore()
        self.correctionStore = CorrectionStore()
        self.usageTracker = UsageTracker(historyStore: historyStore)
        self.audioRecorder = AudioRecorder(preferences: prefs, deviceMonitor: deviceMonitor)
        self.cursorInserter = CursorInserter()
        self.focusedFieldProbe = FocusedFieldProbe()
        self.hudController = HUDController(preferences: prefs)
        self.mediaPauser = MediaPauser()
        self.notifier = Notifier()
        self.updater = UpdaterController()

        // Speakist account manager + API client. AccountManager owns the
        // bearer token; APIClient reads it back via a @MainActor closure so
        // there's no construction-order deadlock (account manager is built
        // without the client and has `bind(client:)` called after).
        let accountManager = SpeakistAccountManager(keychain: keychain)
        self.accountManager = accountManager
        let apiClient = SpeakistAPIClient(
            baseURL: prefs.apiBaseURL,
            tokenProvider: { [weak accountManager] in accountManager?.bearerToken }
        )
        self.apiClient = apiClient
        accountManager.bind(client: apiClient)
        // Lets refreshIdentity write the polish block back into Preferences.
        accountManager.bind(preferences: prefs)
        // Lets the correction store mirror local edits + ingests up to
        // the server so the web vocabulary view stays in sync.
        correctionStore.bind(api: apiClient)

        self.transcriptionService = TranscriptionService(
            preferences: prefs,
            accountManager: accountManager,
            apiClient: apiClient,
            correctionStore: correctionStore,
            historyStore: historyStore,
            audioArchive: audioArchive,
            cursorInserter: cursorInserter,
            focusedFieldProbe: focusedFieldProbe,
            hud: hudController,
            notifier: notifier,
            usage: usageTracker
        )
        hudController.bind(to: audioRecorder)
    }

    func start() {
        deviceMonitor.start()
        historyStore.bootstrap()
        correctionStore.bootstrap()
        audioArchive.bootstrap()
        historyStore.purgeExpired(days: preferences.retentionDays, maxEntries: preferences.maxHistoryEntries)
        audioArchive.pruneToKeepLast(preferences.keepAudio ? preferences.keepAudioCount : 0)
        updater.bootstrap()

        // Pre-warm the audio engine so the first shortcut press doesn't
        // pay 100–250ms of HAL cold-start latency. Self-gates on mic
        // permission and silently no-ops if it's not granted yet — so
        // the OS mic prompt is still tied to the user's first
        // deliberate shortcut press, not launch.
        //
        // We deliberately do *not* prewarm the HUD panel here. The
        // construction is fast (~10–30ms), and creating an
        // NSHostingView before the panel has ever been on screen leaves
        // SwiftUI without a proper layout pass — the `.background`
        // modifier renders empty until the next layout cycle. Lazy
        // first-show construction in `showPreparing()` is correct; the
        // persistent-panel change in `hide()` already covers presses 2+.
        audioRecorder.prewarm()
        // If mic access is granted later in this session (user came
        // back from System Settings, or completed onboarding), re-run
        // the audio prewarm so the first post-grant press is also fast.
        permissions.$mic
            .removeDuplicates()
            .sink { [audioRecorder] state in
                if state == .granted { audioRecorder.prewarm() }
            }
            .store(in: &cancellables)

        // Pull any vocabulary edits made on the web (or another device)
        // since the app last ran. No-op if the user is signed out.
        // didBecomeActive in AppDelegate will keep us in sync after
        // launch.
        Task { @MainActor [correctionStore, apiClient] in
            await correctionStore.syncFromServer(api: apiClient)
        }
    }
}
