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
        // Route through Cloudflare AI Gateway when configured (all channels
        // in production), falling back to direct-to-Deepgram only if the
        // Info.plist key is absent (e.g. tests, or a defensive empty
        // override). Gateway URL pattern:
        //   https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/deepgram/v1/listen
        // The gateway is configured to pass through the Authorization
        // header unchanged, so the minted Deepgram ephemeral key still
        // authenticates us at the Deepgram origin. Body logging and caching
        // are disabled at the gateway rule level — see docs/architecture.
        let gatewayBase = AppIdentity.gatewayBaseURL
        let endpoint = gatewayBase.isEmpty
            ? "https://api.deepgram.com/v1/listen"
            : "\(gatewayBase)/deepgram/v1/listen"
        var components = URLComponents(string: endpoint)!
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
        return TranscriptionResult(text: text, providerModelLabel: model.rawValue, audioSeconds: audioSeconds)
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

private extension ReplaceRule {
    /// Screens out pairs Deepgram can't parse (empty sides, colon in either
    /// half which would be mis-split). Deepgram's `replace` find is case-
    /// insensitive so we lowercase it up front.
    var isValid: Bool {
        let f = find.trimmingCharacters(in: .whitespacesAndNewlines)
        let r = replacement.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !f.isEmpty, !r.isEmpty else { return false }
        if f.contains(":") || r.contains(":") { return false }
        return true
    }
}
