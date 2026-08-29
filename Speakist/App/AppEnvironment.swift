import Foundation
import Combine

/// Dependency container. Lazily constructed and shared across the app.
@MainActor
final class AppEnvironment: ObservableObject {
    let preferences: Preferences
    let permissions: PermissionCoordinator
    let deviceMonitor: DeviceMonitor
    let audioArchive: AudioArchive
    let historyStore: HistoryStore
    let correctionStore: CorrectionStore
    let usageTracker: UsageTracker
    let audioRecorder: AudioRecorder
    let audioMuter: SystemAudioMuter
    let cursorInserter: CursorInserter
    let focusedFieldProbe: FocusedFieldProbe
    let parakeetModel: ParakeetModelManager
    let qwenCleanupModel: QwenCleanupModelManager
    let transcriptionService: TranscriptionService
    let hudController: HUDController
    let notifier: Notifier
    let updater: UpdaterController

    private var cancellables = Set<AnyCancellable>()

    init() {
        Logger.shared.bootstrap()
        let prefs = Preferences()
        self.preferences = prefs
        self.permissions = PermissionCoordinator()
        self.deviceMonitor = DeviceMonitor()
        self.audioArchive = AudioArchive(preferences: prefs)
        self.historyStore = HistoryStore()
        self.correctionStore = CorrectionStore()
        self.usageTracker = UsageTracker(historyStore: historyStore)
        self.audioRecorder = AudioRecorder(preferences: prefs, deviceMonitor: deviceMonitor)
        self.audioMuter = SystemAudioMuter(preferences: prefs)
        self.cursorInserter = CursorInserter()
        self.focusedFieldProbe = FocusedFieldProbe()
        let parakeetModel = ParakeetModelManager()
        self.parakeetModel = parakeetModel
        let qwenCleanupModel = QwenCleanupModelManager()
        self.qwenCleanupModel = qwenCleanupModel
        self.hudController = HUDController(preferences: prefs)
        self.notifier = Notifier()
        self.updater = UpdaterController()

        self.transcriptionService = TranscriptionService(
            preferences: prefs,
            parakeetModel: parakeetModel,
            qwenCleanupModel: qwenCleanupModel,
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
        // The XCTest host constructs the full app environment. Keep unit tests
        // deterministic and fast: their fake Parakeet runtime should never be
        // accompanied by a real Core ML load from this launch-time prewarm.
        if preferences.onboardingCompleted,
           ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil {
            parakeetModel.prepareInBackground()
            qwenCleanupModel.prepareInBackground()
        }
        // If mic access is granted later in this session (user came
        // back from System Settings, or completed onboarding), re-run
        // the audio prewarm so the first post-grant press is also fast.
        permissions.$mic
            .removeDuplicates()
            .sink { [audioRecorder] state in
                if state == .granted { audioRecorder.prewarm() }
            }
            .store(in: &cancellables)
    }
}
