import Foundation

/// Word-level diff that extracts "replacement" pairs where a run of 1–4 tokens
/// maps to a different run of 1–4 tokens between the original and edited strings.
///
/// Grammar-only edits (punctuation-only, common-case re-capitalization) are
/// flagged so callers can exclude them from the STT custom-vocab slots.
struct CorrectionPair: Equatable, Hashable {
    let from: String
    let to: String
    let isProperNounLike: Bool
}

enum DiffEngine {
    static func corrections(from original: String, to edited: String) -> [CorrectionPair] {
        let a = tokenize(original)
        let b = tokenize(edited)
        guard !a.isEmpty else { return [] }

        let ops = levenshteinOps(a: a, b: b)
        var pairs: [CorrectionPair] = []

        var i = 0
        while i < ops.count {
            let op = ops[i]
            if case .equal = op { i += 1; continue }
            // Group contiguous non-equal ops into one replacement pair.
            var fromTokens: [Token] = []
            var toTokens: [Token] = []
            var j = i
            while j < ops.count {
                switch ops[j] {
                case .equal: break
                case .delete(let t): fromTokens.append(t)
                case .insert(let t): toTokens.append(t)
                case .replace(let f, let t):
                    fromTokens.append(f)
                    toTokens.append(t)
                }
                if case .equal = ops[j] { break }
                j += 1
            }
            i = j

            // Cap to 1-4 tokens per side. If either side is larger, split would
            // be ambiguous; we just take the bounded window of changes.
            guard !fromTokens.isEmpty, !toTokens.isEmpty else { continue }
            let boundedFrom = Array(fromTokens.prefix(4))
            let boundedTo = Array(toTokens.prefix(4))

            let fromString = boundedFrom.map(\.text).joined(separator: " ")
            let toString = boundedTo.map(\.text).joined(separator: " ")
            if fromString.isEmpty || toString.isEmpty { continue }
            if normalize(fromString) == normalize(toString) { continue }

            let proper = isProperNounLike(toString)
            pairs.append(CorrectionPair(from: fromString, to: toString, isProperNounLike: proper))
        }

        // De-duplicate while preserving order.
        var seen = Set<CorrectionPair>()
        return pairs.filter { seen.insert($0).inserted }
    }

    static func isProperNounLike(_ text: String) -> Bool {
        let tokens = text.split(whereSeparator: { $0.isWhitespace })
        for t in tokens {
            if t.contains(where: { $0.isNumber }) { return true }
            if t.contains(where: { $0.isUppercase }) { return true }
        }
        return false
    }

    // MARK: - Tokenization

    struct Token: Equatable {
        let text: String
        let normalized: String
    }

    static func tokenize(_ s: String) -> [Token] {
        var tokens: [Token] = []
        var current = ""
        for char in s {
            if char.isLetter || char.isNumber || char == "'" || char == "-" {
                current.append(char)
            } else {
                if !current.isEmpty {
                    tokens.append(Token(text: current, normalized: current.lowercased()))
                    current = ""
                }
            }
        }
        if !current.isEmpty {
            tokens.append(Token(text: current, normalized: current.lowercased()))
        }
        return tokens
    }

    private static func normalize(_ s: String) -> String {
        s.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Levenshtein with op trace

    private enum Op {
        case equal
        case insert(Token)
        case delete(Token)
        case replace(Token, Token)
    }

    private static func levenshteinOps(a: [Token], b: [Token]) -> [Op] {
        let n = a.count, m = b.count
        var dp = Array(repeating: Array(repeating: 0, count: m + 1), count: n + 1)
        for i in 0...n { dp[i][0] = i }
        for j in 0...m { dp[0][j] = j }
        for i in 1...max(n, 1) where i <= n {
            for j in 1...max(m, 1) where j <= m {
                if a[i-1].normalized == b[j-1].normalized {
                    dp[i][j] = dp[i-1][j-1]
                } else {
                    dp[i][j] = 1 + min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
                }
            }
        }

        var ops: [Op] = []
        var i = n, j = m
        while i > 0 || j > 0 {
            if i > 0 && j > 0 && a[i-1].normalized == b[j-1].normalized {
                ops.append(.equal)
                i -= 1; j -= 1
            } else if i > 0 && j > 0 && dp[i][j] == dp[i-1][j-1] + 1 {
                ops.append(.replace(a[i-1], b[j-1]))
                i -= 1; j -= 1
            } else if i > 0 && dp[i][j] == dp[i-1][j] + 1 {
                ops.append(.delete(a[i-1]))
                i -= 1
            } else if j > 0 && dp[i][j] == dp[i][j-1] + 1 {
                ops.append(.insert(b[j-1]))
                j -= 1
            } else {
                break
            }
        }
        return ops.reversed()
    }
}
