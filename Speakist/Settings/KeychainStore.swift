import Foundation
import Security
import Combine

enum KeychainAccount: String, CaseIterable {
    /// Speakist account bearer token (long-lived refresh-token-style).
    /// Used for /api/deepgram/token, /api/usage, /api/vocabulary auth.
    /// Set at the end of device-code sign-in; cleared on sign-out.
    case refreshToken
}

/// Keychain wrapper for Speakist credentials.
/// Service: "com.brevoort-studio.speakist.apikeys"; account = slot rawValue.
/// Prior versions stored a Deepgram API key here directly; that slot is
/// gone now — Deepgram keys are minted short-lived by the server per
/// transcription, never persisted on the Mac.
@MainActor
final class KeychainStore: ObservableObject {
    private let service = "com.brevoort-studio.speakist.apikeys"

    func set(_ value: String?, for account: KeychainAccount) {
        if let value, !value.isEmpty {
            upsert(value: value, account: account.rawValue)
        } else {
            delete(account: account.rawValue)
        }
        objectWillChange.send()
    }

    func get(_ account: KeychainAccount) -> String? {
        read(account: account.rawValue)
    }

    func hasKey(_ account: KeychainAccount) -> Bool {
        guard let v = read(account: account.rawValue) else { return false }
        return !v.isEmpty
    }

    // MARK: - Raw

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
