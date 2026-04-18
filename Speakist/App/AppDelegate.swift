import AppKit
import SwiftUI
import UserNotifications

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let env: AppEnvironment

    private var menuBar: MenuBarController!
    private var shortcutManager: ShortcutManager!
    private var historyWindow: HistoryWindowController?
    private var onboardingWindow: OnboardingWindowController?
    private var settingsWindow: SettingsWindowController?

    override init() {
        self.env = AppEnvironment()
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        env.start()

        menuBar = MenuBarController(env: env) { [weak self] action in
            self?.handleMenuAction(action)
        }
        menuBar.install()

        shortcutManager = ShortcutManager(env: env)
        shortcutManager.start()

        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }

        if !env.preferences.onboardingCompleted {
            showOnboarding()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // MARK: - Menu actions

    private func handleMenuAction(_ action: MenuBarAction) {
        switch action {
        case .openSettings:
            openSettings()
        case .openHistory:
            showHistory()
        case .openOnboarding:
            showOnboarding()
        case .revealLogs:
            Logger.shared.revealInFinder()
        case .toggleShortcutPaused:
            env.preferences.shortcutPaused.toggle()
        case .startToggleRecording:
            shortcutManager.toggleRecording()
        case .quit:
            NSApp.terminate(nil)
        case .copyRecent(let id):
            if let entry = try? env.historyStore.get(id: id) {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(entry.finalTranscript, forType: .string)
            }
        }
    }

    func openSettings() {
        if settingsWindow == nil {
            settingsWindow = SettingsWindowController(env: env)
        }
        settingsWindow?.show()
    }

    func showHistory() {
        if historyWindow == nil {
            historyWindow = HistoryWindowController(env: env)
        }
        historyWindow?.show()
    }

    func showOnboarding() {
        if onboardingWindow == nil {
            onboardingWindow = OnboardingWindowController(env: env) { [weak self] in
                self?.env.preferences.onboardingCompleted = true
                self?.onboardingWindow?.close()
                self?.onboardingWindow = nil
            }
        }
        onboardingWindow?.show()
    }
}
