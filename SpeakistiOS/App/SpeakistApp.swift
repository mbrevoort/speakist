import SwiftUI
import UIKit

/// Main-app entry point for the iOS build. This target is the one Apple
/// sees as "the containing app"; the keyboard extension ships inside its
/// bundle. The containing app is the ONLY process allowed to hold the
/// microphone session (iOS has forbidden mic access to extensions since
/// 2014), so everything record-related lives here and results are piped
/// back to the keyboard via the AppGroupBridge.
@main
struct SpeakistApp: App {
    @StateObject private var session: SpeakSessionController
    @StateObject private var account: SpeakistAccountManager
    @StateObject private var keychain: KeychainStore
    @StateObject private var history = HistoryStore()

    init() {
        Logger.shared.bootstrap()
        Logger.shared.info("SpeakistiOS launched, channel=\(SpeakistChannel.current.rawValue)")

        // Graph wiring — KeychainStore is the token sink; AccountManager
        // owns sign-in state; APIClient takes a closure back to the
        // AccountManager so token rotation propagates without re-plumbing.
        // SpeakSessionController gets a token provider AND the history
        // store so keyboard-driven dictations land in the same list as
        // Quick Dictate ones. `@StateObject` needs deferred init via the
        // underscore backing.
        let keychain = KeychainStore()
        let account = SpeakistAccountManager(keychain: keychain)
        let apiClient = SpeakistAPIClient(
            baseURL: SpeakistChannel.current.defaultAPIBaseURL,
            tokenProvider: { [weak account] in account?.bearerToken }
        )
        account.bind(client: apiClient)

        let history = HistoryStore()
        let session = SpeakSessionController(
            history: history,
            tokenProvider: { [weak account] in account?.bearerToken }
        )

        _keychain = StateObject(wrappedValue: keychain)
        _account = StateObject(wrappedValue: account)
        _session = StateObject(wrappedValue: session)
        _history = StateObject(wrappedValue: history)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .environmentObject(account)
                .environmentObject(keychain)
                .environmentObject(history)
                // Foreground handler. Three jobs:
                //   1. Device-code poll catch-up so sign-in completes
                //      reliably after returning from Safari.
                //   2. Heartbeat on AppGroupBridge.lastForegroundAt so
                //      the keyboard can tell whether we're hot or cold.
                //   3. Consume any pending keyboard-initiated session
                //      request the keyboard couldn't open directly
                //      (iOS 26 blocks keyboard→app URL opens).
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
                    account.pollNow()
                    AppGroupBridge.defaults?.set(
                        Date().timeIntervalSince1970,
                        forKey: AppGroupBridge.Key.lastForegroundAt
                    )
                    session.consumePendingKeyboardRequest()
                }
                .onOpenURL { url in
                    // Deep-links from the keyboard extension arrive here.
                    // The keyboard's only path to bring us foreground is
                    // `extensionContext.open(url)` — this is the pipe.
                    if let route = URLSchemeBridge.route(from: url) {
                        session.handle(route: route)
                    } else {
                        Logger.shared.warn("received unrecognized URL: \(url.absoluteString)")
                    }
                }
        }
    }
}
