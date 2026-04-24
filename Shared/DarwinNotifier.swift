import Foundation

/// Thin wrapper around `CFNotificationCenterGetDarwinNotifyCenter` — the only
/// cross-process signaling mechanism available between an iOS app extension
/// and its containing app. No XPC, no NSDistributedNotificationCenter, no
/// mach ports: Darwin notifications are it.
///
/// Darwin notifications carry no payload — they're pure "something happened"
/// pings. The payload (transcript, session status) goes through the shared
/// UserDefaults in `AppGroupBridge`; the notification just says "check the
/// shared state now."
///
/// All notification names are namespaced under `ai.speakist.<channel>` so
/// local/dev/beta/stable installs don't trigger each other when multiple
/// channels are side-loaded on the same device.
enum DarwinNotification: String {
    /// Keyboard → App: user tapped Speak in the keyboard. App should
    /// activate its Speak Session (open `AVAudioSession` if not already,
    /// start recording).
    case keyboardRequestedActivation

    /// Keyboard → App: user tapped Cancel (X) in the keyboard. App should
    /// stop the current session without inserting.
    case keyboardRequestedCancel

    /// Keyboard → App: user tapped Confirm (check) in the keyboard while
    /// recording was in progress. App should stop recording and transcribe.
    case keyboardRequestedFinish

    /// App → Keyboard: `pendingTranscript` on shared UserDefaults was just
    /// updated with a new streaming chunk. Keyboard should read and pipe it
    /// to `textDocumentProxy.insertText(_:)` (handling deltas, not the full
    /// transcript each time).
    case appPublishedPartial

    /// App → Keyboard: `finalTranscript` on shared UserDefaults was just
    /// updated with the polished final text. Keyboard replaces any partials
    /// and inserts the full final version.
    case appPublishedFinal

    /// App → Keyboard: session state changed (entering listening, etc.).
    /// Keyboard refreshes its UI (e.g. shows the waveform).
    case appStateChanged

    var qualified: String {
        "ai.speakist.\(SpeakistChannel.current.rawValue).\(rawValue)"
    }
}

final class DarwinNotifier {
    static let shared = DarwinNotifier()

    private var observers: [DarwinNotification: [UUID: () -> Void]] = [:]
    private let lock = NSLock()

    private init() {}

    // MARK: - Posting

    /// Fires a Darwin notification. No-op if the other process isn't running
    /// or hasn't registered for the name — this is the natural behavior of
    /// Darwin notifications and the whole reason they're suitable for
    /// always-on extension signaling.
    static func post(_ notification: DarwinNotification) {
        let name = CFNotificationName(notification.qualified as CFString)
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            name,
            nil,
            nil,
            true  // deliverImmediately — fine for our scale (user-gesture-rate)
        )
    }

    // MARK: - Observing

    /// Registers `handler` to run when `notification` fires. Returns an
    /// opaque token — call `remove(_:)` to unregister. The handler always
    /// runs on the main queue; Darwin notifications arrive on a private
    /// queue that's not safe to touch UIKit from.
    @discardableResult
    func observe(_ notification: DarwinNotification, handler: @escaping () -> Void) -> UUID {
        let id = UUID()

        lock.lock()
        let hadAny = (observers[notification]?.isEmpty == false)
        observers[notification, default: [:]][id] = handler
        lock.unlock()

        if !hadAny {
            // First observer for this name — register the underlying CF callback.
            let name = CFNotificationName(notification.qualified as CFString)
            let context = Unmanaged.passUnretained(self).toOpaque()
            CFNotificationCenterAddObserver(
                CFNotificationCenterGetDarwinNotifyCenter(),
                context,
                { _, observer, name, _, _ in
                    guard let observer, let name else { return }
                    let qualified = name.rawValue as String
                    let me = Unmanaged<DarwinNotifier>.fromOpaque(observer).takeUnretainedValue()
                    me.dispatch(qualified: qualified)
                },
                notification.qualified as CFString,
                nil,
                .deliverImmediately
            )
        }

        return id
    }

    func remove(_ token: UUID) {
        lock.lock()
        for (name, var handlers) in observers {
            if handlers.removeValue(forKey: token) != nil {
                observers[name] = handlers.isEmpty ? nil : handlers
                if handlers.isEmpty {
                    let cfname = CFNotificationName(name.qualified as CFString)
                    CFNotificationCenterRemoveObserver(
                        CFNotificationCenterGetDarwinNotifyCenter(),
                        Unmanaged.passUnretained(self).toOpaque(),
                        cfname,
                        nil
                    )
                }
                break
            }
        }
        lock.unlock()
    }

    private func dispatch(qualified: String) {
        lock.lock()
        let matching = observers.first(where: { $0.key.qualified == qualified })
        let handlers = matching?.value.values.map { $0 } ?? []
        lock.unlock()

        guard !handlers.isEmpty else { return }
        DispatchQueue.main.async {
            for handler in handlers {
                handler()
            }
        }
    }
}
