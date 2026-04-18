import Foundation
import AVFoundation
import AppKit
import ApplicationServices
import Combine

enum PermissionState: Equatable {
    case notDetermined
    case granted
    case denied
}

@MainActor
final class PermissionCoordinator: ObservableObject {
    @Published private(set) var mic: PermissionState = .notDetermined
    @Published private(set) var accessibility: PermissionState = .notDetermined

    private var pollTimer: Timer?
    private var notificationObservers: [NSObjectProtocol] = []

    init() {
        let rawMic = AVCaptureDevice.authorizationStatus(for: .audio)
        let trusted = AXIsProcessTrustedWithOptions(nil)
        Logger.shared.info("Permission boot: mic raw=\(rawMic.rawValue) (0=undetermined,1=restricted,2=denied,3=authorized), ax trusted=\(trusted)")
        refresh()
        startPolling()
        observeAppActivation()
    }

    deinit {
        pollTimer?.invalidate()
        for token in notificationObservers {
            NotificationCenter.default.removeObserver(token)
            NSWorkspace.shared.notificationCenter.removeObserver(token)
            DistributedNotificationCenter.default().removeObserver(token)
        }
    }

    func refresh() {
        let rawMic = AVCaptureDevice.authorizationStatus(for: .audio)
        let newMic: PermissionState
        switch rawMic {
        case .authorized: newMic = .granted
        case .denied, .restricted: newMic = .denied
        case .notDetermined: newMic = .notDetermined
        @unknown default: newMic = .notDetermined
        }
        if newMic != mic {
            Logger.shared.info("Mic permission: \(mic) → \(newMic) (raw=\(rawMic.rawValue))")
            mic = newMic
        }

        // `AXIsProcessTrustedWithOptions(nil)` re-evaluates the trust database
        // instead of returning a cached value like `AXIsProcessTrusted()` does
        // in some macOS revisions.
        let trusted = AXIsProcessTrustedWithOptions(nil)
        let newAX: PermissionState
        if trusted {
            newAX = .granted
        } else if accessibility == .granted {
            newAX = .denied
        } else if accessibility == .notDetermined {
            newAX = .notDetermined
        } else {
            newAX = .denied
        }
        if newAX != accessibility {
            Logger.shared.info("Accessibility permission: \(accessibility) → \(newAX)")
            accessibility = newAX
        }
    }

    func requestMicrophone() async -> Bool {
        let preStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        Logger.shared.info("requestMicrophone called; pre-status=\(preStatus.rawValue)")
        let granted = await AVCaptureDevice.requestAccess(for: .audio)
        let postStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        Logger.shared.info("requestMicrophone result=\(granted); post-status=\(postStatus.rawValue)")
        await MainActor.run {
            self.mic = granted ? .granted : (postStatus == .notDetermined ? .notDetermined : .denied)
        }
        return granted
    }

    @discardableResult
    func promptAccessibility() -> Bool {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        let trusted = AXIsProcessTrustedWithOptions(options)
        accessibility = trusted ? .granted : .denied
        if !trusted {
            openAccessibilitySettings()
        }
        return trusted
    }

    func openAccessibilitySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    func openMicrophoneSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: - Polling & activation observers

    /// Poll in `.common` run-loop mode so the timer still fires while the user
    /// is interacting with the onboarding window (SwiftUI event tracking would
    /// otherwise starve a `.default`-mode timer).
    private func startPolling() {
        let timer = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    /// When the user flips a permission toggle in System Settings and switches
    /// back to Speakist, we get a `didBecomeActive` right away — refresh then
    /// so the UI doesn't have to wait for the next poll tick.
    private func observeAppActivation() {
        let nc = NotificationCenter.default
        let activeToken = nc.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main) { [weak self] _ in
                Task { @MainActor in self?.refresh() }
            }
        notificationObservers.append(activeToken)

        let wsToken = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main) { [weak self] _ in
                Task { @MainActor in self?.refresh() }
            }
        notificationObservers.append(wsToken)
    }
}
