import Foundation
import UserNotifications
import AppKit

@MainActor
final class Notifier {
    private let center = UNUserNotificationCenter.current()

    func post(title: String, body: String, identifier: String = UUID().uuidString) {
        center.getNotificationSettings { [center] settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
                return
            }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = nil
            let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
            center.add(request, withCompletionHandler: nil)
        }
    }

    func pasteFailed() {
        post(title: "Copied to clipboard",
             body: "Couldn't paste where your cursor is — paste manually with ⌘V.")
    }

    func transcriptionFailed(_ error: String) {
        post(title: "Transcription failed",
             body: "\(error). Audio saved — retry from History.")
    }

    func modelsPreparing() {
        post(title: "Speakist is getting ready",
             body: "The on-device models are still being prepared. Check Settings → Transcription for progress.")
    }

    func maxDurationHit(minutes: Int) {
        post(title: "Reached max recording length",
             body: "Transcribing the first \(minutes) minutes.")
    }

    func micDenied() {
        post(title: "Microphone access needed",
             body: "Open System Settings to enable.")
    }

    func accessibilityDenied() {
        post(title: "Accessibility access needed",
             body: "Speakist needs it to paste at your cursor.")
    }
}
