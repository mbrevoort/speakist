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
    let text: String
    let providerModelLabel: String
    let audioSeconds: Double
}

protocol TranscriptionClient: Sendable {
    func transcribe(audioURL: URL, keyterms: [String], language: String?) async throws -> TranscriptionResult
    var providerLabel: String { get }
    var modelLabel: String { get }
}

// ---- Provider + model selection --------------------------------------------

/// Supported upstream STT providers the Mac can ask the Worker to route to.
/// The server's `/api/transcribe` accepts the `rawValue` as `X-Provider-Hint`.
/// Keep in sync with `web/src/lib/transcription/types.ts#ProviderId`.
enum TranscriptionProvider: String, CaseIterable, Identifiable, Codable {
    case deepgram
    case groq
    // Phase C: case openai, case xai

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .deepgram: return "Deepgram"
        case .groq: return "Groq Whisper"
        }
    }

    /// Model slugs supported by this provider. The first is the default when
    /// a user switches providers in Settings.
    var models: [String] {
        switch self {
        case .deepgram: return ["nova-3", "nova-2"]
        case .groq: return ["whisper-large-v3-turbo", "whisper-large-v3"]
        }
    }

    var defaultModel: String { models[0] }

    /// User-friendly labels for the model picker. Falls back to the raw
    /// slug if we don't have a nicer label.
    func modelDisplayName(_ slug: String) -> String {
        switch (self, slug) {
        case (.deepgram, "nova-3"): return "Nova-3 (latest)"
        case (.deepgram, "nova-2"): return "Nova-2"
        case (.groq, "whisper-large-v3-turbo"): return "Whisper v3 Turbo (fastest, cheapest)"
        case (.groq, "whisper-large-v3"): return "Whisper v3 Large (most accurate)"
        default: return slug
        }
    }
}
