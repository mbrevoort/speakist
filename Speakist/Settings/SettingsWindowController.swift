import AppKit
import SwiftUI

/// Explicit Settings window, bypassing SwiftUI's `Settings` scene which
/// doesn't reliably respond to `showSettingsWindow:` in LSUIElement apps.
@MainActor
final class SettingsWindowController: NSWindowController, NSWindowDelegate {
    private let env: AppEnvironment

    init(env: AppEnvironment) {
        self.env = env
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 860, height: 580),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        // The sidebar toggle + traffic lights + tabs eat into the title area,
        // so keep the title short. App identity is shown in the sidebar header.
        window.title = "Settings"
        window.minSize = NSSize(width: 720, height: 520)
        window.center()
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self

        let root = SettingsWindow()
            .environmentObject(env.preferences)
            .environmentObject(env.keychain)
            .environmentObject(env.correctionStore)
            .environmentObject(env.usageTracker)
            .environmentObject(env.permissions)
            .environmentObject(env.deviceMonitor)
            .environmentObject(env.accountManager)
            .environmentObject(env)
        window.contentView = NSHostingView(rootView: root)
    }

    required init?(coder: NSCoder) { fatalError() }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        showWindow(nil)
        window?.orderFrontRegardless()
    }
}
