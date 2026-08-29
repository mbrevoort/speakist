import Foundation

enum TranscriptionError: Error, LocalizedError {
    case localModel(String)
    case empty
    case canceled

    var errorDescription: String? {
        switch self {
        case .localModel(let msg): return "Local transcription error: \(msg)"
        case .empty: return "No speech detected."
        case .canceled: return "Canceled."
        }
    }
}

struct ReplaceRule: Equatable, Hashable {
    let find: String
    let replacement: String

    var isValid: Bool {
        let source = find.trimmingCharacters(in: .whitespacesAndNewlines)
        let target = replacement.trimmingCharacters(in: .whitespacesAndNewlines)
        return !source.isEmpty && !target.isEmpty
    }
}

struct TranscriptionResult: Sendable {
    /// The cleaned text the client should display and paste.
    let text: String
    /// Speech-to-text output before local cleanup, when available.
    let rawText: String?
    /// True when the guarded cleanup stage made a safe change.
    let cleanupApplied: Bool
    let providerModelLabel: String
    let audioSeconds: Double

    init(
        text: String,
        rawText: String?,
        cleanupApplied: Bool = false,
        providerModelLabel: String,
        audioSeconds: Double
    ) {
        self.text = text
        self.rawText = rawText
        self.cleanupApplied = cleanupApplied
        self.providerModelLabel = providerModelLabel
        self.audioSeconds = audioSeconds
    }
}

protocol TranscriptionClient: Sendable {
    func transcribe(audioURL: URL) async throws -> TranscriptionResult
    var providerLabel: String { get }
    var modelLabel: String { get }
}
