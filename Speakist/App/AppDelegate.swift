import AppKit
import SwiftUI
import UserNotifications

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let env: AppEnvironment

    private var menuBar: MenuBarController!
    private var shortcutManager: ShortcutManager!
    private var mainWindow: MainWindowController?
    private var onboardingWindow: OnboardingWindowController?

    override init() {
        self.env = AppEnvironment()
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Speakist now ships as a regular Dock + Cmd+Tab app. Earlier
        // versions were menu-bar-only (`.accessory`) and only became
        // regular while a user-facing window was on screen — but users
        // who couldn't find the menu bar icon had no way back into the
        // app. Going `.regular` permanently means there's always a
        // Dock entry and the app is reachable from Cmd+Tab. The status
        // bar icon stays installed for at-a-glance recording state.
        NSApp.setActivationPolicy(.regular)

        // Install the top menu bar in two stages:
        //
        //   1. Defer the first install to the next main-runloop tick
        //      via `DispatchQueue.main.async`. SwiftUI rebuilds the
        //      menu from its `Settings` scene on its first scene pass,
        //      which runs *after* `applicationDidFinishLaunching`
        //      returns — installing synchronously here gets clobbered.
        //
        //   2. Re-install on every `didBecomeActive` (wired below). If
        //      SwiftUI ever re-renders its scenes (e.g. when the
        //      Settings window opens/closes), it'll regenerate the
        //      menu and overwrite ours; the activate-time reinstall
        //      is our safety net.
        //
        // We tried routing menu items through SwiftUI's `.commands`
        // system, but Button actions on a `Settings` scene only fire
        // when that scene's window is key, which never happens here
        // (we use our own `NSWindowController` for the main window).
        // AppKit-owned `NSApp.mainMenu` is the only reliable path.
        DispatchQueue.main.async { [weak self] in
            self?.installMainMenu()
        }

        Analytics.shared.bootstrap()
        env.start()

        menuBar = MenuBarController(env: env) { [weak self] action in
            self?.handleMenuAction(action)
        }
        menuBar.install()

        shortcutManager = ShortcutManager(env: env)
        shortcutManager.start()

        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }

        // Refresh /api/me + vocabulary whenever the app comes back to
        // the foreground. Picks up account-level state changes the user
        // made in the browser — invitation accepted, workspace switched
        // via the dashboard topbar, balance topped up, dictionary
        // entries added/edited/deleted, etc. Both calls are idempotent
        // and cheap, so re-firing them on every foreground is harmless.
        let center = NotificationCenter.default
        center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                // Re-install in case SwiftUI rebuilt the menu since
                // last activation. No-op cost if the menu pointer is
                // already ours.
                self.installMainMenu()
                await self.env.accountManager.refreshIdentity()
                await self.env.correctionStore.syncFromServer(api: self.env.apiClient)
            }
        }

        if env.preferences.onboardingCompleted {
            // First-launch UX: show the unified main window so users
            // discover the new in-app surface immediately. Skipped
            // during onboarding because the onboarding window owns
            // the screen until it's dismissed.
            showMainWindow()
        } else {
            showOnboarding()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Re-open the main window when the user clicks the Dock icon
    /// after closing everything. Standard `.regular` app behavior —
    /// without this the click is a no-op.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showMainWindow() }
        return true
    }

    // MARK: - Menu actions

    private func handleMenuAction(_ action: MenuBarAction) {
        switch action {
        case .openMain:
            showMainWindow()
        case .openSettings:
            showMainWindow(section: .account)
        case .openHistory:
            showMainWindow(section: .history)
        case .openQuickDictate:
            showMainWindow(section: .quickDictate)
        case .openOnboarding:
            showOnboarding()
        case .revealLogs:
            Logger.shared.revealInFinder()
        case .checkForUpdates:
            env.updater.checkForUpdates()
        case .startToggleRecording:
            shortcutManager.toggleRecording()
        case .quit:
            NSApp.terminate(nil)
        }
    }

    func showMainWindow(section: MainSection? = nil) {
        if mainWindow == nil {
            mainWindow = MainWindowController(env: env)
        }
        mainWindow?.show(section: section)
    }

    func showOnboarding() {
        if onboardingWindow == nil {
            onboardingWindow = OnboardingWindowController(env: env) { [weak self] in
                self?.env.preferences.onboardingCompleted = true
                self?.onboardingWindow?.close()
                self?.onboardingWindow = nil
                // Drop the user into the main window the moment they
                // finish onboarding so the new surface is the first
                // thing they see.
                self?.showMainWindow()
            }
        }
        onboardingWindow?.show()
    }

    // MARK: - App menu (top menu bar)

    /// Build and install Speakist's top menu bar. Called deferred from
    /// `applicationDidFinishLaunching` (to dodge SwiftUI's initial
    /// scene pass that overwrites NSApp.mainMenu) and again from every
    /// `didBecomeActive` notification (as a safety net in case SwiftUI
    /// regenerates its menu later).
    func installMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        appMenuItem.submenu = buildAppMenu()
        mainMenu.addItem(appMenuItem)

        let editMenuItem = NSMenuItem()
        editMenuItem.submenu = buildEditMenu()
        mainMenu.addItem(editMenuItem)

        let viewMenuItem = NSMenuItem()
        viewMenuItem.submenu = buildViewMenu()
        mainMenu.addItem(viewMenuItem)

        let windowMenuItem = NSMenuItem()
        let windowMenu = buildWindowMenu()
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)
        NSApp.windowsMenu = windowMenu

        let helpMenuItem = NSMenuItem()
        let helpMenu = buildHelpMenu()
        helpMenuItem.submenu = helpMenu
        mainMenu.addItem(helpMenuItem)
        NSApp.helpMenu = helpMenu

        NSApp.mainMenu = mainMenu
    }

    private func buildAppMenu() -> NSMenu {
        let name = AppIdentity.displayName
        let menu = NSMenu(title: name)

        menu.addItem(withTitle: "About \(name)",
                     action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                     keyEquivalent: "")
        menu.addItem(.separator())

        // First action item in the Speakist menu so the main window is
        // always one click away — recovery path when the user has
        // closed the window. ⌘O reads as "open the app" rather than
        // ⌘N's "create something new", which fits a single-window app.
        let openMain = NSMenuItem(title: "Open Window",
                                  action: #selector(handleAppMenuOpenMain),
                                  keyEquivalent: "o")
        openMain.target = self
        menu.addItem(openMain)

        menu.addItem(.separator())

        let settings = NSMenuItem(title: "Settings…",
                                  action: #selector(handleAppMenuSettings),
                                  keyEquivalent: ",")
        settings.target = self
        menu.addItem(settings)

        let checkUpdates = NSMenuItem(title: "Check for Updates…",
                                      action: #selector(handleAppMenuCheckForUpdates),
                                      keyEquivalent: "")
        checkUpdates.target = self
        menu.addItem(checkUpdates)

        menu.addItem(.separator())

        let services = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        let servicesMenu = NSMenu(title: "Services")
        services.submenu = servicesMenu
        NSApp.servicesMenu = servicesMenu
        menu.addItem(services)

        menu.addItem(.separator())

        menu.addItem(withTitle: "Hide \(name)",
                     action: #selector(NSApplication.hide(_:)),
                     keyEquivalent: "h")
        let hideOthers = NSMenuItem(title: "Hide Others",
                                    action: #selector(NSApplication.hideOtherApplications(_:)),
                                    keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        menu.addItem(hideOthers)
        menu.addItem(withTitle: "Show All",
                     action: #selector(NSApplication.unhideAllApplications(_:)),
                     keyEquivalent: "")

        menu.addItem(.separator())

        menu.addItem(withTitle: "Quit \(name)",
                     action: #selector(NSApplication.terminate(_:)),
                     keyEquivalent: "q")

        return menu
    }

    private func buildEditMenu() -> NSMenu {
        let menu = NSMenu(title: "Edit")
        menu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        menu.addItem(redo)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        menu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        menu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        menu.addItem(withTitle: "Delete", action: #selector(NSText.delete(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        return menu
    }

    private func buildViewMenu() -> NSMenu {
        let menu = NSMenu(title: "View")
        let quick = NSMenuItem(title: "Quick Dictate",
                               action: #selector(handleViewQuickDictate),
                               keyEquivalent: "1")
        quick.target = self
        menu.addItem(quick)
        let history = NSMenuItem(title: "History",
                                 action: #selector(handleViewHistory),
                                 keyEquivalent: "2")
        history.target = self
        menu.addItem(history)
        let settings = NSMenuItem(title: "Settings",
                                  action: #selector(handleViewSettings),
                                  keyEquivalent: "3")
        settings.target = self
        menu.addItem(settings)
        return menu
    }

    private func buildWindowMenu() -> NSMenu {
        let menu = NSMenu(title: "Window")
        let show = NSMenuItem(title: "Show \(AppIdentity.displayName)",
                              action: #selector(handleWindowShowMain),
                              keyEquivalent: "0")
        show.target = self
        menu.addItem(show)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Minimize",
                     action: #selector(NSWindow.performMiniaturize(_:)),
                     keyEquivalent: "m")
        menu.addItem(withTitle: "Zoom",
                     action: #selector(NSWindow.performZoom(_:)),
                     keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Bring All to Front",
                     action: #selector(NSApplication.arrangeInFront(_:)),
                     keyEquivalent: "")
        return menu
    }

    private func buildHelpMenu() -> NSMenu {
        let menu = NSMenu(title: "Help")
        let onboarding = NSMenuItem(title: "Show Onboarding",
                                    action: #selector(handleHelpShowOnboarding),
                                    keyEquivalent: "")
        onboarding.target = self
        menu.addItem(onboarding)
        let logs = NSMenuItem(title: "Reveal Logs in Finder",
                              action: #selector(handleHelpRevealLogs),
                              keyEquivalent: "")
        logs.target = self
        menu.addItem(logs)
        return menu
    }

    // MARK: - Menu selectors

    @objc private func handleAppMenuOpenMain() { handleMenuAction(.openMain) }
    @objc private func handleAppMenuSettings() { handleMenuAction(.openSettings) }
    @objc private func handleAppMenuCheckForUpdates() { handleMenuAction(.checkForUpdates) }
    @objc private func handleViewQuickDictate() { handleMenuAction(.openQuickDictate) }
    @objc private func handleViewHistory() { handleMenuAction(.openHistory) }
    @objc private func handleViewSettings() { handleMenuAction(.openSettings) }
    @objc private func handleWindowShowMain() { handleMenuAction(.openMain) }
    @objc private func handleHelpShowOnboarding() { handleMenuAction(.openOnboarding) }
    @objc private func handleHelpRevealLogs() { handleMenuAction(.revealLogs) }
}
