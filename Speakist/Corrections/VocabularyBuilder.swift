import Foundation

@MainActor
enum VocabularyBuilder {
    /// Exact rules applied to the on-device transcript before cleanup.
    static func replaceRules(from store: CorrectionStore, limit: Int = 200) -> [ReplaceRule] {
        store.replaceRules(limit: limit)
    }

}
