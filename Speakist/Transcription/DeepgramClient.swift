import Foundation

struct DeepgramClient: TranscriptionClient {
    let apiKey: String
    let model: DeepgramModel

    var providerLabel: String { "deepgram" }
    var modelLabel: String { model.rawValue }

    func transcribe(audioURL: URL, keyterms: [String], language: String?) async throws -> TranscriptionResult {
        var components = URLComponents(string: "https://api.deepgram.com/v1/listen")!
        var queryItems: [URLQueryItem] = [
            URLQueryItem(name: "model", value: model.rawValue),
            URLQueryItem(name: "smart_format", value: "true"),
            URLQueryItem(name: "punctuate", value: "true")
        ]
        if let lang = language, !lang.isEmpty {
            queryItems.append(URLQueryItem(name: "language", value: lang))
        }
        for term in keyterms where !term.isEmpty {
            let name = (model == .nova3) ? "keyterm" : "keywords"
            queryItems.append(URLQueryItem(name: name, value: term))
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
