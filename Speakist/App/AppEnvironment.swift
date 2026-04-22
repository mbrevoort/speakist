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
    let notifier: Notifier
    let updater: UpdaterController
    let accountManager: SpeakistAccountManager
    let apiClient: SpeakistAPIClient

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
        // Lets refreshIdentity write the cleanup block back into Preferences.
        accountManager.bind(preferences: prefs)

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
    }
}
