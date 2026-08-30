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

        // Pre-warm the audio engine so the first shortcut press doesn't pay
        // the HAL cold-start latency, but only after the background device
        // scan proves Core Audio is responding and microphone access exists.
        // The first HAL lookup can otherwise wait forever when coreaudiod is
        // wedged; doing any prewarm work synchronously here would turn that
        // system failure into a beach ball before Speakist shows a window.
        //
        // We deliberately do *not* prewarm the HUD panel here. The
        // construction is fast (~10–30ms), and creating an
        // NSHostingView before the panel has ever been on screen leaves
        // SwiftUI without a proper layout pass — the `.background`
        // modifier renders empty until the next layout cycle. Lazy
        // first-show construction in `showPreparing()` is correct; the
        // persistent-panel change in `hide()` already covers presses 2+.
        // The XCTest host constructs the full app environment. Keep unit tests
        // deterministic and fast: their fake Parakeet runtime should never be
        // accompanied by a real Core ML load from this launch-time prewarm.
        if preferences.onboardingCompleted,
           ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil {
            parakeetModel.prepareInBackground()
            qwenCleanupModel.prepareInBackground()
        }
        // This also covers a permission granted later in the session: the
        // combined state emits once both the permission and a healthy device
        // snapshot are available.
        Publishers.CombineLatest(deviceMonitor.$isAudioAvailable, permissions.$mic)
            .removeDuplicates { lhs, rhs in
                lhs.0 == rhs.0 && lhs.1 == rhs.1
            }
            .sink { [audioRecorder] audioAvailable, micState in
                // Local builds are frequently launched alongside an installed
                // channel during development. The cross-channel instance lock
                // now prevents that at runtime, and skipping Local prewarm also
                // ensures unit-test/dev hosts never retain an idle HAL client.
                // Shipped stable/dev/beta builds keep the first-press latency
                // optimization when they are the sole Speakist process.
                let isTestHost = ProcessInfo.processInfo.environment[
                    "XCTestConfigurationFilePath"] != nil
                if audioAvailable,
                   micState == .granted,
                   AppIdentity.channel != "local",
                   !isTestHost {
                    audioRecorder.prewarm()
                }
            }
            .store(in: &cancellables)
    }
}
