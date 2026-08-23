import Foundation

/// A pause observed between two decoded Parakeet words.  The word index is
/// relative to the whitespace-delimited transcript, which is intentionally
/// small and stable enough for the cleanup pass to use as a hint rather than
/// as a second source of truth.
struct ParakeetPause: Sendable, Equatable {
    let afterWordIndex: Int
    let seconds: Double
}

struct LocalTranscriptCleanupResult: Sendable, Equatable {
    let text: String
    let applied: Bool
    let reason: String
    let processingSeconds: Double
}

/// Rejects any cleanup candidate that changes the spoken word sequence.  The
/// current deterministic pass is expected to pass exactly; the same gate is
/// intentionally available to a future generative model so a bad decode falls
/// back to the transcript that Parakeet produced.
enum LocalTranscriptSafetyGate {
    static func accepts(original: String, candidate: String) -> Bool {
        let originalTokens = tokens(in: original)
        let candidateTokens = tokens(in: candidate)
        guard !candidateTokens.isEmpty || originalTokens.isEmpty else {
            return false
        }
        return originalTokens == candidateTokens
    }

    private static func tokens(in text: String) -> [String] {
        text
            .lowercased()
            .replacingOccurrences(of: "'", with: "")
            .replacingOccurrences(of: "’", with: "")
            .split { !$0.isLetter && !$0.isNumber }
            .map(String.init)
    }
}

/// The cleanup boundary is deliberately an async protocol.  The shipping
/// implementation below is deterministic and runs entirely in-process, but
/// this seam lets us add a validated Core ML / MLX grammar model without
/// changing the transcription client or making model failures user-visible.
protocol LocalTranscriptCleanupRuntime: Sendable {
    func cleanup(
        text: String,
        pauses: [ParakeetPause]
    ) async -> LocalTranscriptCleanupResult
}

/// Fast, offline cleanup for speech transcripts.  It fixes the two problems
/// that are safe to infer without inventing content:
///
/// 1. Parakeet may emit a full stop after a thinking pause even though the
///    next decoded words continue the same clause.
/// 2. Speech-to-text commonly drops apostrophes in a small, well-known set of
///    contractions.
///
/// It never completes a dangling thought, paraphrases, removes content, or
/// sends text over the network.  A future generative model must pass the same
/// content-preservation gate before it can replace this result.
struct DeterministicLocalTranscriptCleanup: LocalTranscriptCleanupRuntime {
    private static let minimumPauseSeconds = 0.55

    private static let incompleteEndings: Set<String> = [
        "a", "an", "and", "are", "as", "at", "because", "be", "been",
        "but", "by", "can", "could", "did", "do", "does", "for", "from",
        "had", "has", "have", "if", "in", "is", "it", "just", "may",
        "might", "must", "not", "of", "on", "or", "should", "so", "than",
        "that", "the", "to", "was", "were", "which", "while", "will",
        "with", "would"
    ]

    /// Words that commonly follow an interrupted clause.  Restricting the
    /// repair to this set avoids joining two intentional sentences such as
    /// "I could. My colleague agreed.".
    private static let continuationWords: Set<String> = [
        "a", "an", "also", "and", "another", "any", "because", "be", "been",
        "being", "but", "can", "could", "do", "does", "even", "for", "from",
        "get", "go", "have", "if", "in", "is", "it", "just", "make", "may",
        "might", "more", "not", "of", "on", "or", "so", "some",
        "that", "the", "there", "these", "this", "to", "try", "use",
        "was", "we", "were", "what", "which", "will", "with", "would", "you",
        "your"
    ]

    private static let contractions: [(String, String)] = [
        ("couldnt", "couldn't"), ("couldntve", "couldn't've"),
        ("didnt", "didn't"), ("doesnt", "doesn't"), ("dont", "don't"),
        ("hadnt", "hadn't"), ("hasnt", "hasn't"), ("havent", "haven't"),
        ("im", "I'm"), ("ive", "I've"), ("id", "I'd"), ("ill", "I'll"),
        ("isnt", "isn't"), ("itd", "it'd"), ("itll", "it'll"),
        ("lets", "let's"), ("mustnt", "mustn't"), ("shouldnt", "shouldn't"),
        ("thats", "that's"), ("theyre", "they're"), ("theyve", "they've"),
        ("wasnt", "wasn't"), ("werent", "weren't"), ("whatll", "what'll"),
        ("whats", "what's"), ("wont", "won't"), ("wouldnt", "wouldn't"),
        ("youre", "you're"), ("youve", "you've")
    ]

    func cleanup(
        text: String,
        pauses: [ParakeetPause]
    ) async -> LocalTranscriptCleanupResult {
        let started = CFAbsoluteTimeGetCurrent()
        let normalized = Self.normalizeWhitespace(text)
        guard !normalized.isEmpty else {
            return Self.result(
                text: normalized,
                applied: false,
                reason: "empty",
                started: started)
        }

        let repaired = Self.repairPrematureBoundaries(
            in: normalized,
            pauses: pauses)
        let contracted = Self.restoreContractions(in: repaired)
        let finalText = Self.normalizeWhitespace(contracted)
        guard LocalTranscriptSafetyGate.accepts(
            original: normalized,
            candidate: finalText) else {
            return Self.result(
                text: normalized,
                applied: false,
                reason: "unsafe-content-change",
                started: started)
        }
        let applied = finalText != text.trimmingCharacters(in: .whitespacesAndNewlines)
        let reason: String
        if repaired != normalized {
            reason = "pause-boundary-repair"
        } else if contracted != repaired {
            reason = "contraction-and-punctuation"
        } else {
            reason = "no-safe-change"
        }
        return Self.result(
            text: finalText,
            applied: applied,
            reason: reason,
            started: started)
    }

    private static func result(
        text: String,
        applied: Bool,
        reason: String,
        started: CFAbsoluteTime
    ) -> LocalTranscriptCleanupResult {
        LocalTranscriptCleanupResult(
            text: text,
            applied: applied,
            reason: reason,
            processingSeconds: CFAbsoluteTimeGetCurrent() - started)
    }

    private static func normalizeWhitespace(_ text: String) -> String {
        var output = text
            .replacingOccurrences(of: "\u{00a0}", with: " ")
            .replacingOccurrences(
                of: #"\s+"#,
                with: " ",
                options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        // ASR sometimes leaves a space before punctuation or duplicates a
        // space after it.  This changes presentation only, not wording.
        output = output.replacingOccurrences(
            of: #"\s+([,.!?;:])"#,
            with: "$1",
            options: .regularExpression)
        output = output.replacingOccurrences(
            of: #"([,.!?;:])(?=[A-Za-z])"#,
            with: "$1 ",
            options: .regularExpression)
        return output.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func repairPrematureBoundaries(
        in text: String,
        pauses: [ParakeetPause]
    ) -> String {
        // Work from the original string and rebuild each match so we can
        // count words before the boundary.  The regex deliberately only
        // targets a period; question/exclamation marks are much more likely
        // to be intentional in spoken dictation.
        let pattern = #"(?i)\b([A-Za-z][A-Za-z'’-]*)\.\s+([A-Za-z][A-Za-z'’-]*)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return text
        }
        let fullRange = NSRange(text.startIndex..<text.endIndex, in: text)
        let matches = regex.matches(in: text, range: fullRange)
        guard !matches.isEmpty else { return text }

        var output = text
        for match in matches.reversed() {
            guard match.numberOfRanges == 3,
                  let firstRange = Range(match.range(at: 1), in: output),
                  let nextRange = Range(match.range(at: 2), in: output) else {
                continue
            }
            let previousWord = output[firstRange].lowercased()
            let nextWord = output[nextRange].lowercased()
            guard Self.incompleteEndings.contains(previousWord),
                  Self.continuationWords.contains(nextWord) else {
                continue
            }

            let wordsBefore = Self.wordCount(
                in: String(output[..<firstRange.lowerBound]))
            let afterWordIndex = wordsBefore
            if !pauses.isEmpty,
               !pauses.contains(where: {
                   $0.seconds >= Self.minimumPauseSeconds
                       && $0.afterWordIndex == afterWordIndex
               }) {
                continue
            }

            let replacementRange = NSRange(
                firstRange.lowerBound..<nextRange.upperBound,
                in: output)
            let replacement = "\(output[firstRange]) \(Self.lowercasedFirstLetter(output[nextRange]))"
            output = (output as NSString).replacingCharacters(
                in: replacementRange,
                with: replacement)
        }
        return output
    }

    private static func lowercasedFirstLetter(_ word: Substring) -> String {
        guard let first = word.first else { return String(word) }
        return String(first).lowercased() + word.dropFirst()
    }

    private static func wordCount(in text: String) -> Int {
        text.split { character in
            !(character.isLetter || character.isNumber || character == "'" || character == "’")
        }.count
    }

    private static func restoreContractions(in text: String) -> String {
        var output = text
        for (source, replacement) in contractions {
            let pattern = "(?i)(?<![\\p{L}\\p{N}_])\(source)(?![\\p{L}\\p{N}_])"
            guard let regex = try? NSRegularExpression(pattern: pattern) else {
                continue
            }
            let range = NSRange(output.startIndex..<output.endIndex, in: output)
            output = regex.stringByReplacingMatches(
                in: output,
                range: range,
                withTemplate: NSRegularExpression.escapedTemplate(for: replacement))
        }
        return output
    }
}
