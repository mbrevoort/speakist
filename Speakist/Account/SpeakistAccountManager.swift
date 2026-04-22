import Foundation
import Combine
import AppKit

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
    /// Preferences is optional so the manager can be constructed before the
    /// full app graph is wired; call `bind(preferences:)` to enable the
    /// /api/me polish-cache sync. If unbound, refreshIdentity still
    /// updates `state` but skips the Preferences write.
    private var preferences: Preferences?
    private var client: SpeakistAPIClient?
    private var pollTask: Task<Void, Never>?

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

    /// Inject Preferences so the /api/me polish block writes back to the
    /// local Settings cache. Called by AppEnvironment after both objects
    /// exist.
    func bind(preferences: Preferences) {
        self.preferences = preferences
    }

    /// Current bearer token, if any. Callable from any task via the @MainActor
    /// closure SpeakistAPIClient holds.
    var bearerToken: String? {
        keychain.get(.refreshToken)
    }

    var isSignedIn: Bool {
        keychain.hasKey(.refreshToken)
    }

    // MARK: - Device-code sign-in

    /// Kicks off the device-code flow:
    ///   1. POST /api/device/start → gets user_code + device_code
    ///   2. Opens the verification URL in the default browser
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
            NSWorkspace.shared.open(url)
            startPolling(deviceCode: resp.deviceCode, interval: max(1, resp.interval), expiresAt: expiresAt)
        } catch {
            Logger.shared.warn("startSignIn failed: \(String(describing: error))")
            self.lastError = humanErrorMessage(error)
        }
    }

    private func startPolling(deviceCode: String, interval: Int, expiresAt: Date) {
        pollTask?.cancel()
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

                guard let client = await self.client else { return }

                do {
                    let token = try await client.pollDeviceAuth(deviceCode: deviceCode)
                    await self.completeSignIn(token: token)
                    return
                } catch SpeakistAPIClient.Error.devicePending {
                    continue
                } catch SpeakistAPIClient.Error.deviceExpired {
                    await self.handleSignInFailure(.deviceExpired)
                    return
                } catch {
                    Logger.shared.warn("device poll failed: \(String(describing: error))")
                    // Transient — keep polling until expiry.
                }
            }
        }
    }

    private func completeSignIn(token: String) {
        keychain.set(token, for: .refreshToken)
        state = .signedIn(identity: nil)
        lastError = nil
        pollTask = nil
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
            // Hydrate the local polish cache so Settings renders accurate
            // state on launch without a separate /api/me/polish call.
            if let polish = me.polish {
                preferences?.applyPolishFromServer(
                    enabled: polish.enabled,
                    systemPrompt: polish.systemPrompt,
                    isCustom: polish.isCustom,
                    defaultPrompt: polish.defaultPrompt
                )
            }
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
    }

    // MARK: - Sign out

    func signOut() {
        pollTask?.cancel()
        pollTask = nil
        keychain.set(nil, for: .refreshToken)
        state = .signedOut
        lastError = nil
        Logger.shared.info("signed out; token removed from keychain")

        // Phase 7 optional: POST /api/auth/revoke to kill the server-side
        // mac_sessions row too. For now the token just dead-letters; user
        // can revoke from /dashboard/settings.
    }

    // MARK: - Helpers

    private func deviceNameForMac() -> String {
        // "Mike's MacBook Pro" → gives the user something readable when they
        // manage their sessions from the web.
        let host = Host.current().localizedName ?? "Mac"
        return host
    }

    private func humanErrorMessage(_ err: Swift.Error) -> String {
        if let apiErr = err as? SpeakistAPIClient.Error {
            return apiErr.description
        }
        return err.localizedDescription
    }
}
