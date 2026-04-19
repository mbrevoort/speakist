import Foundation

@MainActor
enum VocabularyBuilder {
    /// Keyterm list sent to Deepgram for custom-vocab bias.
    /// Biases the acoustic model but doesn't guarantee substitution —
    /// paired with `replaceRules` below for belt-and-suspenders application.
    static func keyterms(from store: CorrectionStore, limit: Int = 50) -> [String] {
        store.keyterms(limit: limit)
    }

    /// Replace rules sent to Deepgram's `replace=find:replacement` param.
    /// Applied server-side after transcription, so any correction that the
    /// keyterm bias missed still lands correctly in the final string.
    static func replaceRules(from store: CorrectionStore, limit: Int = 200) -> [ReplaceRule] {
        store.replaceRules(limit: limit)
    }
}
