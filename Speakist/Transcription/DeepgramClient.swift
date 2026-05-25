import Foundation

/// One find/replace pair for Deepgram's `replace=find:replacement` parameter.
/// `find` is case-insensitive on Deepgram's side; `replacement` preserves case.
struct ReplaceRule: Equatable, Hashable {
    let find: String
    let replacement: String
}

struct DeepgramClient: TranscriptionClient {
    let apiKey: String
    let model: DeepgramModel
    let dictation: Bool
    let fillerWords: Bool
    let measurements: Bool
    let profanityFilter: Bool
    let detectLanguage: Bool
    let replaceRules: [ReplaceRule]

    init(apiKey: String,
         model: DeepgramModel,
         dictation: Bool = false,
         fillerWords: Bool = false,
         measurements: Bool = false,
         profanityFilter: Bool = false,
         detectLanguage: Bool = false,
         replaceRules: [ReplaceRule] = []) {
        self.apiKey = apiKey
        self.model = model
        self.dictation = dictation
        self.fillerWords = fillerWords
        self.measurements = measurements
        self.profanityFilter = profanityFilter
        self.detectLanguage = detectLanguage
        self.replaceRules = replaceRules
    }

    var providerLabel: String { "deepgram" }
    var modelLabel: String { model.rawValue }

    func transcribe(audioURL: URL, keyterms: [String], language: String?) async throws -> TranscriptionResult {
        var components = URLComponents(string: "https://api.deepgram.com/v1/listen")!
        var queryItems: [URLQueryItem] = [
            URLQueryItem(name: "model", value: model.rawValue),
            URLQueryItem(name: "smart_format", value: "true"),
            URLQueryItem(name: "punctuate", value: "true")
        ]
        if dictation {
            queryItems.append(URLQueryItem(name: "dictation", value: "true"))
        }
        if fillerWords {
            queryItems.append(URLQueryItem(name: "filler_words", value: "true"))
        }
        if measurements {
            queryItems.append(URLQueryItem(name: "measurements", value: "true"))
        }
        if profanityFilter {
            queryItems.append(URLQueryItem(name: "profanity_filter", value: "true"))
        }
        // `language` and `detect_language` are mutually exclusive — Deepgram
        // errors if both are set.
        if detectLanguage {
            queryItems.append(URLQueryItem(name: "detect_language", value: "true"))
        } else if let lang = language, !lang.isEmpty {
            queryItems.append(URLQueryItem(name: "language", value: lang))
        }
        for term in keyterms where !term.isEmpty {
            let name = (model == .nova3) ? "keyterm" : "keywords"
            queryItems.append(URLQueryItem(name: name, value: term))
        }
        // `replace=find:replacement` — up to ~200 pairs; Deepgram skips any that
        // can't be parsed. We defensively drop pairs containing a colon in the
        // find or replacement since that would break the `:`-separator.
        for rule in replaceRules.prefix(200) where rule.isValid {
            queryItems.append(URLQueryItem(name: "replace", value: "\(rule.find):\(rule.replacement)"))
        }
        components.queryItems = queryItems

        guard let url = components.url else { throw TranscriptionError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Token \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30

        let audioData: Data
        do {
            audioData = try Data(contentsOf: audioURL)
        } catch {
            throw TranscriptionError.network("Couldn't read audio file: \(error.localizedDescription)")
        }

        let (data, response) = try await URLSession.shared.upload(for: request, from: audioData)
        guard let http = response as? HTTPURLResponse else {
            throw TranscriptionError.invalidResponse
        }

        switch http.statusCode {
        case 200...299: break
        case 401, 403: throw TranscriptionError.authFailed
        case 429: throw TranscriptionError.rateLimited
        default:
            let body = String(data: data, encoding: .utf8)
            throw TranscriptionError.serverError(http.statusCode, body)
        }

        let decoded: DeepgramResponse
        do {
            decoded = try JSONDecoder().decode(DeepgramResponse.self, from: data)
        } catch {
            throw TranscriptionError.invalidResponse
        }

        let text = decoded.results?.channels.first?.alternatives.first?.transcript ?? ""
        let audioSeconds = decoded.metadata?.duration ?? 0
        // Direct-to-Deepgram path doesn't run polish, so `text` is
        // already the raw STT — leave rawText nil to signal "same as
        // text" rather than duplicating the string.
        return TranscriptionResult(
            text: text,
            rawText: nil,
            providerModelLabel: model.rawValue,
            audioSeconds: audioSeconds
        )
    }

    // MARK: - Response model

    private struct DeepgramResponse: Decodable {
        let metadata: Metadata?
        let results: Results?

        struct Metadata: Decodable {
            let duration: Double?
        }
        struct Results: Decodable {
            let channels: [Channel]
        }
        struct Channel: Decodable {
            let alternatives: [Alternative]
        }
        struct Alternative: Decodable {
            let transcript: String
        }
    }
}

extension ReplaceRule {
    /// Screens out pairs Deepgram can't parse (empty sides, colon in either
    /// half which would be mis-split). Deepgram's `replace` find is case-
    /// insensitive so we lowercase it up front. Used by both DeepgramClient
    /// (direct-to-provider path) and SpeakistTranscribeClient (proxy path,
    /// which filters before serializing pairs into the X-Replace header).
    var isValid: Bool {
        let f = find.trimmingCharacters(in: .whitespacesAndNewlines)
        let r = replacement.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !f.isEmpty, !r.isEmpty else { return false }
        if f.contains(":") || r.contains(":") { return false }
        return true
    }
}
