import Foundation
import Security
import Combine

enum KeychainAccount: String, CaseIterable {
    /// Speakist account bearer token (long-lived refresh-token-style).
    /// Used for /api/deepgram/token, /api/usage, /api/vocabulary auth.
    /// Set at the end of device-code sign-in; cleared on sign-out.
    case refreshToken
}

/// Bearer-token store. On macOS we store in the real Keychain (Generic
/// Password, per-channel service name). On iOS we store in the App Group
/// shared UserDefaults — the keychain on iOS requires `keychain-access-
/// groups` entitlements and signed builds, neither of which are available
/// in the unsigned simulator scaffold (write attempts fail with
/// `errSecMissingEntitlement` / -34018). App Group UserDefaults isn't as
/// secure as the Keychain, but:
///
///   * the container is sandbox-scoped to this app + its extension
///   * the bearer token is a refresh-token-class credential the server
///     can revoke any time
///   * we can upgrade to a shared Keychain access group once the Apple
///     Developer provisioning is set up for production builds
///
/// The class name stays `KeychainStore` so the Mac app's call sites don't
/// change; the iOS impl just takes a different path internally.
@MainActor
final class KeychainStore: ObservableObject {
    private let service = "\(AppIdentity.bundleID).apikeys"

    func set(_ value: String?, for account: KeychainAccount) {
        #if canImport(UIKit)
        setAppGroup(value: value, account: account.rawValue)
        #else
        if let value, !value.isEmpty {
            upsert(value: value, account: account.rawValue)
        } else {
            delete(account: account.rawValue)
        }
        #endif
        objectWillChange.send()
    }

    func get(_ account: KeychainAccount) -> String? {
        #if canImport(UIKit)
        return readAppGroup(account: account.rawValue)
        #else
        return read(account: account.rawValue)
        #endif
    }

    func hasKey(_ account: KeychainAccount) -> Bool {
        guard let v = get(account) else { return false }
        return !v.isEmpty
    }

    #if canImport(UIKit)
    // MARK: - iOS: App Group UserDefaults

    private func appGroupKey(_ account: String) -> String {
        "speakist.token.\(account)"
    }

    private func setAppGroup(value: String?, account: String) {
        guard let defaults = AppGroupBridge.defaults else {
            Logger.shared.warn("App Group UserDefaults unavailable — token not persisted")
            return
        }
        if let value, !value.isEmpty {
            defaults.set(value, forKey: appGroupKey(account))
        } else {
            defaults.removeObject(forKey: appGroupKey(account))
        }
    }

    private func readAppGroup(account: String) -> String? {
        AppGroupBridge.defaults?.string(forKey: appGroupKey(account))
    }
    #endif

    // MARK: - macOS: real Keychain

    private func upsert(value: String, account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: value.data(using: .utf8) ?? Data(),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            add.merge(attributes, uniquingKeysWith: { $1 })
            let addStatus = SecItemAdd(add as CFDictionary, nil)
            if addStatus != errSecSuccess {
                Logger.shared.warn("Keychain add failed for \(account): OSStatus \(addStatus)")
            }
        } else if status != errSecSuccess {
            Logger.shared.warn("Keychain update failed for \(account): OSStatus \(status)")
        }
    }

    private func read(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let data = item as? Data,
              let string = String(data: data, encoding: .utf8) else {
            return nil
        }
        return string
    }

    private func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}
