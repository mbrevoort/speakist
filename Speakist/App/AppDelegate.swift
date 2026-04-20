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

        // Dynamic activation policy: when a user-facing window (Settings,
        // History, Onboarding) is visible, become a regular app so we show
        // up in Cmd+Tab and the Dock. When no such window is open, revert
        // to .accessory (menu-bar-only). See updateActivationPolicy().
        let center = NotificationCenter.default
        center.addObserver(forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.updateActivationPolicy() }
        }
        center.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                // Poll after the window actually goes away — willClose fires
                // just before isVisible flips.
                try? await Task.sleep(nanoseconds: 50_000_000)
                self?.updateActivationPolicy()
            }
        }

        if !env.preferences.onboardingCompleted {
            showOnboarding()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Switch between `.regular` (Dock icon + Cmd+Tab presence) when any
    /// user-facing window is on screen, and `.accessory` (menu-bar-only) when
    /// none are. We filter to `canBecomeKey` + `.normal` level so the HUD
    /// panel and status-bar items don't accidentally keep us in .regular.
    private func updateActivationPolicy() {
        let hasUserWindow = NSApp.windows.contains { w in
            w.isVisible && w.canBecomeKey && w.level == .normal
        }
        let target: NSApplication.ActivationPolicy = hasUserWindow ? .regular : .accessory
        guard NSApp.activationPolicy() != target else { return }
        NSApp.setActivationPolicy(target)
    }

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
