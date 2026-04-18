import Foundation

@MainActor
enum VocabularyBuilder {
    /// Keyterm / prompt list sent to the STT provider.
    static func keyterms(for provider: TranscriptionProvider, from store: CorrectionStore) -> [String] {
        let limit = (provider == .deepgram) ? 50 : 10
        return store.keyterms(limit: limit)
    }

    /// Dictionary appended to the cleanup-pass system prompt.
    static func cleanupDictionary(from store: CorrectionStore, limit: Int = 200) -> [String: String] {
        var dict: [String: String] = [:]
        for (from, to) in store.dictionary(limit: limit) {
            dict[from] = to
        }
        return dict
    }
}
