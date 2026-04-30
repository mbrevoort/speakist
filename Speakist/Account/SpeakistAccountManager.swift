import Foundation
import Combine

#if canImport(AppKit)
import AppKit
#endif

#if canImport(UIKit)
import UIKit
#endif

/// Owns the Mac app's Speakist account state. Single source of truth for:
///   * the bearer refresh token (stored in Keychain as `.refreshToken`)
///   * published sign-in state for the Settings UI to observe
///   * the device-code flow from start to polling to token arrival
///
/// State machine:
///
///   .signedOut ──startSignIn()──▶ .signingIn(code:url:) ──poll-succeeds──▶ .signedIn(email)
///       ▲                                  │
///       │                                  └──poll-expires──▶ .signedOut  (notify user)
///       │
///       └──signOut()─────────────────────── (from any state)
///
/// The manager doesn't know anything about HTTP — it delegates every network
/// call to `SpeakistAPIClient`, which it was constructed with a closure to
/// provide the token back to. Clean dependency graph: APIClient owes nothing
/// upward, AccountManager owns state + workflow.
@MainActor
final class SpeakistAccountManager: ObservableObject {
    /// Identity shown in the Settings Account tab. Populated by /api/me
    /// after sign-in and on rehydration; `nil` while a fetch is still in
    /// flight or if the server is unreachable — the UI falls back to a
    /// generic "Signed in" in that case.
    struct Identity: Equatable {
        var email: String
        var displayName: String?
        var orgName: String?
        var orgRole: String?
        var balanceMillicents: Int?
    }

    enum SignInState: Equatable {
        case signedOut
        case signingIn(userCode: String, verificationURL: URL, expiresAt: Date)
        case signedIn(identity: Identity?)  // nil identity = we know you're signed in but /api/me hasn't responded yet
    }

    @Published private(set) var state: SignInState = .signedOut
    @Published private(set) var lastError: String?

    private let keychain: KeychainStore
    #if canImport(AppKit)
    /// Preferences is optional so the manager can be constructed before the
    /// full app graph is wired; call `bind(preferences:)` to enable the
    /// /api/me polish-cache sync. If unbound, refreshIdentity still
    /// updates `state` but skips the Preferences write. iOS target doesn't
    /// reuse Preferences (the Mac Settings model isn't ported), so this
    /// slot is macOS-only.
    private var preferences: Preferences?
    #endif
    private var client: SpeakistAPIClient?
    /// Read-only accessor for views that need to call API methods directly
    /// (e.g., the iOS Polish settings screen). Nil until `bind(client:)`
    /// completes during app construction. Mac code uses `env.apiClient`
    /// instead — this is the path for iOS where there's no AppEnvironment
    /// wrapper yet.
    var apiClient: SpeakistAPIClient? { client }

    private var pollTask: Task<Void, Never>?

    /// Snapshot of the active device-code pair so `pollNow()` can fire a
    /// single off-cycle poll when the app comes foreground after the user
    /// approved in Safari. Without this we'd wait up to `interval` seconds
    /// for the next scheduled sleep to expire — and on iOS a suspended
    /// background app pauses Task.sleep, so that window can be arbitrarily
    /// long.
    private var activeDeviceCode: (code: String, expiresAt: Date)?

    init(keychain: KeychainStore) {
        self.keychain = keychain

        // Rehydrate: if we already have a saved token, assume signed-in.
        // Identity is nil until refreshIdentity() completes; UI falls back
        // to "Signed in" while that's in flight.
        if let token = keychain.get(.refreshToken), !token.isEmpty {
            self.state = .signedIn(identity: nil)
        }
    }

    /// Inject the API client after construction (avoids construction-order
    /// deadlock with APIClient needing a token provider back to us).
    func bind(client: SpeakistAPIClient) {
        self.client = client
        // Kick off an identity fetch if we rehydrated as signed-in.
        if case .signedIn = state {
            Task { await refreshIdentity() }
        }
    }

    #if canImport(AppKit)
    /// Inject Preferences so the /api/me polish block writes back to the
    /// local Settings cache. Called by AppEnvironment after both objects
    /// exist. macOS only — iOS doesn't use the Mac Preferences type.
    func bind(preferences: Preferences) {
        self.preferences = preferences
    }
    #endif

    /// Current bearer token, if any. Callable from any task via the @MainActor
    /// closure SpeakistAPIClient holds.
    var bearerToken: String? {
        keychain.get(.refreshToken)
    }

    nonisolated var isSignedIn: Bool {
        // Safe to read the keychain from any actor — SecItemCopyMatching
        // is thread-safe and the UserDefaults fallback on iOS is too.
        // Declared `nonisolated` so SwiftUI can read it in view builders
        // without an implicit `await`.
        MainActor.assumeIsolated { keychain.hasKey(.refreshToken) }
    }

    // MARK: - Device-code sign-in

    /// Kicks off the device-code flow:
    ///   1. POST /api/device/start → gets user_code + device_code
    ///   2. Stores the verification URL + user_code on `state` so the
    ///      sign-in UI can render them side by side. The Mac UI does
    ///      NOT auto-launch the browser — auto-launch yanks the user
    ///      into whichever browser was last in focus, which on a
    ///      multi-browser / multi-profile machine is rarely the one
    ///      they actually want to sign in from. They click (or copy)
    ///      the link from the panel themselves. iOS still auto-opens
    ///      because `UIApplication.shared.open` routes through Safari
    ///      (the default by definition) and there's no profile picker.
    ///   3. Starts polling /api/device/poll every `interval` seconds
    ///   4. On "authorized", saves the token → state becomes .signedIn
    ///
    /// Safe to call if already signed in — it'll sign out first (so the user
    /// doesn't end up with two stacked sessions from stale UI).
    func startSignIn() async {
        pollTask?.cancel()
        lastError = nil

        if isSignedIn {
            Logger.shared.info("startSignIn called while signed in — clearing prior token")
            keychain.set(nil, for: .refreshToken)
        }

        guard let client else {
            Logger.shared.warn("startSignIn called before APIClient bound")
            lastError = "Internal error — client not initialized"
            return
        }

        do {
            let resp = try await client.requestDeviceCodes(deviceName: deviceNameForMac())
            let expiresAt = Date().addingTimeInterval(TimeInterval(resp.expiresIn))
            guard let url = URL(string: resp.verificationURLWithCode) else {
                throw SpeakistAPIClient.Error.badResponse
            }

            self.state = .signingIn(userCode: resp.userCode, verificationURL: url, expiresAt: expiresAt)
            // Mac users open the link from the sign-in panel themselves
            // (multi-browser / profile-aware UX). iOS still auto-opens —
            // there's only one Safari + no profile picker to worry about.
            #if canImport(UIKit) && !canImport(AppKit)
            await UIApplication.shared.open(url)
            #endif
            startPolling(deviceCode: resp.deviceCode, interval: max(1, resp.interval), expiresAt: expiresAt)
        } catch {
            Logger.shared.warn("startSignIn failed: \(String(describing: error))")
            self.lastError = humanErrorMessage(error)
        }
    }

    private func startPolling(deviceCode: String, interval: Int, expiresAt: Date) {
        pollTask?.cancel()
        activeDeviceCode = (code: deviceCode, expiresAt: expiresAt)
        Logger.shared.info("device-code polling started (interval=\(interval)s, expires in \(Int(expiresAt.timeIntervalSinceNow))s)")
        pollTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                // Quit if we passed the pair's expiry.
                if Date() >= expiresAt {
                    await self.handleSignInFailure(.deviceExpired)
                    return
                }

                do {
                    try await Task.sleep(nanoseconds: UInt64(interval) * 1_000_000_000)
                } catch { return }  // cancellation

                if Task.isCancelled { return }
                if await self.attemptPollOnce(deviceCode: deviceCode) {
                    return  // authorized or fatal — polling loop exits
                }
            }
        }
    }

    /// Single-shot poll used by both the scheduled loop and `pollNow()`.
    /// Returns `true` if the loop should stop (authorized or fatal error),
    /// `false` if the caller should keep looping.
    private func attemptPollOnce(deviceCode: String) async -> Bool {
        guard let client = self.client else { return true }
        do {
            let token = try await client.pollDeviceAuth(deviceCode: deviceCode)
            Logger.shared.info("device poll returned authorized")
            self.completeSignIn(token: token)
            return true
        } catch SpeakistAPIClient.Error.devicePending {
            return false
        } catch SpeakistAPIClient.Error.deviceExpired {
            Logger.shared.warn("device poll returned expired")
            self.handleSignInFailure(.deviceExpired)
            return true
        } catch {
            Logger.shared.warn("device poll failed: \(String(describing: error))")
            return false
        }
    }

    /// Fire a single off-cycle poll, useful when the app just came
    /// foreground after the user approved in Safari. Safe to call in any
    /// state — it no-ops outside `.signingIn`. Runs *alongside* the
    /// scheduled `pollTask`; whichever resolves first wins (they both
    /// exit on `.signedIn` transition via the Keychain write + state
    /// assignment guard in `completeSignIn`).
    func pollNow() {
        guard case .signingIn = state, let info = activeDeviceCode else { return }
        Logger.shared.info("pollNow triggered (foreground refresh)")
        Task { [weak self] in
            guard let self else { return }
            _ = await self.attemptPollOnce(deviceCode: info.code)
        }
    }

    private func completeSignIn(token: String) {
        // Idempotent guard: if another poll already succeeded and flipped
        // us to `.signedIn`, don't rewrite state (could cause a duplicate
        // /api/me fetch at best, a transient UI flicker at worst).
        if case .signedIn = state { return }

        keychain.set(token, for: .refreshToken)
        state = .signedIn(identity: nil)
        lastError = nil
        pollTask?.cancel()
        pollTask = nil
        activeDeviceCode = nil
        Logger.shared.info("signed in; token stored in keychain")

        // Fetch identity so the Settings view can show email + org right
        // away instead of a bare "Signed in" placeholder.
        Task { await refreshIdentity() }

        // Future (v1.1): fetch /api/vocabulary here so CorrectionStore is
        // hydrated before the first transcription.
    }

    /// Populate (or refresh) the identity shown in the Settings Account tab.
    /// Non-fatal if it fails — we stay `.signedIn(identity: nil)` and the
    /// UI renders a generic signed-in state.
    func refreshIdentity() async {
        guard let client else { return }
        guard case .signedIn = state else { return }
        do {
            let me = try await client.fetchMe()
            let identity = Identity(
                email: me.email,
                displayName: me.displayName,
                orgName: me.org?.name,
                orgRole: me.org?.role,
                balanceMillicents: me.org?.balanceMillicents
            )
            state = .signedIn(identity: identity)
            #if canImport(AppKit)
            // Hydrate the local polish cache so Settings renders accurate
            // state on launch without a separate /api/me/polish call.
            if let polish = me.polish {
                preferences?.applyPolishFromServer(
                    enabled: polish.enabled,
                    mode: polish.mode,
                    systemPrompt: polish.systemPrompt,
                    isCustom: polish.isCustom,
                    defaultPrompt: polish.defaultPrompt
                )
            }
            #endif
        } catch SpeakistAPIClient.Error.notSignedIn {
            // Server says our token is no good. Treat as signed out.
            signOut()
        } catch {
            Logger.shared.warn("refreshIdentity failed: \(String(describing: error))")
            // leave state as .signedIn(identity: nil)
        }
    }

    private func handleSignInFailure(_ err: SpeakistAPIClient.Error) {
        state = .signedOut
        lastError = err.description
        pollTask = nil
        activeDeviceCode = nil
    }

    // MARK: - Sign out

    func signOut() {
        pollTask?.cancel()
        pollTask = nil
        activeDeviceCode = nil
        keychain.set(nil, for: .refreshToken)
        state = .signedOut
        lastError = nil
        Logger.shared.info("signed out; token removed from keychain")

        // Phase 7 optional: POST /api/auth/revoke to kill the server-side
        // mac_sessions row too. For now the token just dead-letters; user
        // can revoke from /dashboard/settings.
    }

    /// Permanently delete the signed-in user's account, then locally
    /// sign out. Throws on server-side failure with the token left
    /// intact so the caller can surface the error and the user can
    /// retry. On success, the keychain is cleared and `state` flips
    /// to `.signedOut` exactly as if `signOut()` had been called —
    /// the server-side user row is gone, so any lingering token is
    /// already useless.
    ///
    /// Required for App Review on iOS (5.1.1(v)). The Mac app reuses
    /// this same path; UI surfacing it on Mac is optional but cheap to
    /// add later.
    func deleteAccount() async throws {
        guard let client else {
            throw SpeakistAPIClient.Error.notSignedIn
        }
        try await client.deleteAccount()
        // Server-side deletion succeeded — local cleanup mirrors signOut.
        // Done explicitly (rather than calling signOut()) so the log
        // line accurately reflects what happened.
        pollTask?.cancel()
        pollTask = nil
        activeDeviceCode = nil
        keychain.set(nil, for: .refreshToken)
        state = .signedOut
        lastError = nil
        Logger.shared.info("account deleted; token cleared")
    }

    // MARK: - Helpers

    private func deviceNameForMac() -> String {
        // Readable per-device label shown in /dashboard/sessions when the
        // user wants to revoke a device.
        #if canImport(AppKit)
        return Host.current().localizedName ?? "Mac"
        #elseif canImport(UIKit)
        return UIDevice.current.name   // "iPhone" in iOS 16+ unless entitled
        #else
        return "Speakist Device"
        #endif
    }

    private func humanErrorMessage(_ err: Swift.Error) -> String {
        if let apiErr = err as? SpeakistAPIClient.Error {
            return apiErr.description
        }
        return err.localizedDescription
    }
}
