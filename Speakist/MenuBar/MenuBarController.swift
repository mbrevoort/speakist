import Foundation
import AppKit
import Combine
import SwiftUI
import KeyboardShortcuts

enum MenuBarAction {
    case openSettings
    case openHistory
    case openOnboarding
    case revealLogs
    case startToggleRecording
    case quit
}

@MainActor
final class MenuBarController: NSObject, NSMenuDelegate {
    private let env: AppEnvironment
    private let dispatch: (MenuBarAction) -> Void

    private var statusItem: NSStatusItem?
    private let menu = NSMenu()
    private var cancellables = Set<AnyCancellable>()
    /// Optional-so-the-first-draw-always-runs. The `refreshIcon` guard used
    /// to compare against `.idle` and bail when that was also the initial
    /// state, leaving the button blank until a state change fired.
    private var iconState: IconState?
    private var animationTimer: Timer?
    private var animationPhase: CGFloat = 0

    init(env: AppEnvironment, dispatch: @escaping (MenuBarAction) -> Void) {
        self.env = env
        self.dispatch = dispatch
    }

    func install() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.imagePosition = .imageOnly
        // Attach the menu directly — macOS then handles showing it on click,
        // which is far more reliable than the target/action + performClick
        // approach and ensures menu item actions dispatch to their targets
        // on a proper runloop tick.
        menu.delegate = self
        item.menu = menu
        self.statusItem = item
        refreshIcon()
        installObservers()
    }

    // MARK: - Observers

    private func installObservers() {
        env.audioRecorder.$isRecording
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refreshIcon() }
            .store(in: &cancellables)

        env.hudController.$state
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refreshIcon() }
            .store(in: &cancellables)

        env.preferences.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refreshIcon() }
            .store(in: &cancellables)
    }

    // MARK: - Menu (rebuilt lazily each time it opens)

    nonisolated func menuNeedsUpdate(_ menu: NSMenu) {
        MainActor.assumeIsolated {
            rebuildMenu(menu)
        }
    }

    private func rebuildMenu(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.autoenablesItems = false

        let status = NSMenuItem(title: statusLine(), action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)
        menu.addItem(.separator())

        if KeyboardShortcutsBridge.hasToggleShortcut() {
            let toggle = NSMenuItem(
                title: env.audioRecorder.isRecording ? "Stop Recording" : "Start Recording",
                action: #selector(handleStartToggle),
                keyEquivalent: "")
            toggle.target = self
            menu.addItem(toggle)
        }

        let history = NSMenuItem(title: "History…", action: #selector(handleOpenHistory), keyEquivalent: "")
        history.target = self
        menu.addItem(history)

        menu.addItem(.separator())

        let settings = NSMenuItem(title: "Settings…", action: #selector(handleOpenSettings), keyEquivalent: ",")
        settings.target = self
        menu.addItem(settings)

        menu.addItem(.separator())

        let onboarding = NSMenuItem(title: "Show Onboarding", action: #selector(handleOpenOnboarding), keyEquivalent: "")
        onboarding.target = self
        menu.addItem(onboarding)

        let logs = NSMenuItem(title: "Reveal Logs in Finder", action: #selector(handleRevealLogs), keyEquivalent: "")
        logs.target = self
        menu.addItem(logs)

        menu.addItem(.separator())

        // Use the channel's display name so the menu reads "Quit Speakist",
        // "Quit Speakist Dev", "Quit Speakist Local", etc. — matches what
        // the Dock / Cmd+Tab / Privacy panes show for this install.
        let quit = NSMenuItem(title: "Quit \(AppIdentity.displayName)", action: #selector(handleQuit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    // MARK: - Menu handlers

    @objc private func handleOpenSettings() { dispatch(.openSettings) }
    @objc private func handleOpenHistory() { dispatch(.openHistory) }
    @objc private func handleOpenOnboarding() { dispatch(.openOnboarding) }
    @objc private func handleRevealLogs() { dispatch(.revealLogs) }
    @objc private func handleStartToggle() { dispatch(.startToggleRecording) }
    @objc private func handleQuit() { dispatch(.quit) }

    // MARK: - Icon state

    private enum IconState { case idle, recording, transcribing, paused }

    private func currentState() -> IconState {
        if env.preferences.shortcutPaused { return .paused }
        switch env.hudController.state {
        case .recording: return .recording
        case .transcribing: return .transcribing
        case .hidden:
            return env.audioRecorder.isRecording ? .recording : .idle
        }
    }

    private func refreshIcon() {
        let newState = currentState()
        guard newState != iconState else { return }
        iconState = newState
        stopAnimation()
        guard let button = statusItem?.button else { return }
        button.alphaValue = 1.0
        button.contentTintColor = nil // colors are baked into the image itself
        // Tooltip uses the channel's display name so hovering a running
        // Speakist Dev icon doesn't read "Speakist • Ready" — important when
        // two channels are installed side-by-side.
        let name = AppIdentity.displayName
        switch newState {
        case .idle:
            button.image = MenuBarIcon.make()  // black → template, auto-tinted
            button.toolTip = "\(name) • Ready"
        case .recording:
            button.image = MenuBarIcon.make(fill: .speakistPeach)
            button.toolTip = "\(name) • Recording"
            startAnimation(.recording)
        case .transcribing:
            button.image = MenuBarIcon.make(fill: NSColor(red: 0.894, green: 0.714, blue: 0.227, alpha: 1.0))
            button.toolTip = "\(name) • Transcribing"
            startAnimation(.transcribing)
        case .paused:
            button.image = MenuBarIcon.make()
            button.alphaValue = 0.45
            button.toolTip = "\(name) • Paused"
        }
    }

    // MARK: - Animation

    private enum AnimationStyle { case recording, transcribing }

    private func startAnimation(_ style: AnimationStyle) {
        animationPhase = 0
        animationTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.animationPhase += 1.0 / 30.0
                switch style {
                case .recording:
                    // Gentle breathing pulse in alpha (0.55 ↔ 1.0)
                    let alpha = 0.55 + 0.45 * (0.5 + 0.5 * sin(2 * .pi * self.animationPhase / 0.9))
                    self.statusItem?.button?.alphaValue = alpha
                case .transcribing:
                    // Slower brighter/darker shimmer (0.70 ↔ 1.0)
                    let alpha = 0.70 + 0.30 * (0.5 + 0.5 * sin(2 * .pi * self.animationPhase / 1.4))
                    self.statusItem?.button?.alphaValue = alpha
                }
            }
        }
    }

    private func stopAnimation() {
        animationTimer?.invalidate()
        animationTimer = nil
        statusItem?.button?.alphaValue = 1.0
    }

    private func statusLine() -> String {
        if env.preferences.shortcutPaused { return "Paused" }
        return "Ready"
    }
}

private enum KeyboardShortcutsBridge {
    @MainActor
    static func hasToggleShortcut() -> Bool {
        KeyboardShortcuts.getShortcut(for: .toggleRecord) != nil
    }
}
