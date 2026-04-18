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

    func maxDurationHit(minutes: Int) {
        post(title: "Reached max recording length",
             body: "Transcribing the first \(minutes) minutes.")
    }

    func apiKeyRejected(provider: String) {
        post(title: "API key rejected",
             body: "Check your \(provider) key in Settings.")
    }

    func missingApiKey(provider: String) {
        post(title: "\(provider) key missing",
             body: "Add it in Settings → Transcription.")
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
