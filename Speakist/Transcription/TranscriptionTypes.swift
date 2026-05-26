import Foundation

enum TranscriptionError: Error, LocalizedError {
    case noApiKey
    case invalidResponse
    case authFailed
    case rateLimited
    case serverError(Int, String?)
    case network(String)
    case empty
    case canceled

    var errorDescription: String? {
        switch self {
        case .noApiKey: return "No API key configured."
        case .invalidResponse: return "Unexpected response from the transcription service."
        case .authFailed: return "API key was rejected."
        case .rateLimited: return "Rate limited — try again in a moment."
        case .serverError(let code, let msg): return "Server error \(code)\(msg.map { ": \($0)" } ?? "")."
        case .network(let msg): return "Network error: \(msg)"
        case .empty: return "No speech detected."
        case .canceled: return "Canceled."
        }
    }

    var isAuthFailure: Bool {
        if case .authFailed = self { return true }
        return false
    }
}

struct TranscriptionResult: Sendable {
    /// The text the client should display / paste. On the Phase-A
    /// proxy path this is the post-polish output; on the legacy
    /// Deepgram-direct path polish doesn't run, so it's just the
    /// raw STT.
    let text: String
    /// Pre-polish STT output, when the path that produced this result
    /// went through a polish stage AND that stage's input is
    /// recoverable. `nil` means the caller should treat `text` as
    /// both raw and final (true on the Deepgram-direct legacy path,
    /// and also true on the proxy path when the server is older than
    /// the rawText-response change).
    let rawText: String?
    let providerModelLabel: String
    let audioSeconds: Double
}

protocol TranscriptionClient: Sendable {
    func transcribe(audioURL: URL, keyterms: [String], language: String?) async throws -> TranscriptionResult
    var providerLabel: String { get }
    var modelLabel: String { get }
}

// Provider + model selection moved server-side. The Worker chooses
// based on the user's language preference and the org's allowed-models
// list (configured in the super admin UI). See
// `web/src/app/api/transcribe/route.ts` for the resolution logic.
