import Foundation

struct OpenAITranscribeClient: TranscriptionClient {
    let apiKey: String
    let model: OpenAITranscribeModel

    var providerLabel: String { "openai" }
    var modelLabel: String { model.rawValue }

    func transcribe(audioURL: URL, keyterms: [String], language: String?) async throws -> TranscriptionResult {
        let url = URL(string: "https://api.openai.com/v1/audio/transcriptions")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 30

        let boundary = "Speakist-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        let audioData: Data
        do {
            audioData = try Data(contentsOf: audioURL)
        } catch {
            throw TranscriptionError.network("Couldn't read audio file: \(error.localizedDescription)")
        }

        var form = MultipartFormBuilder(boundary: boundary)
        form.addField(name: "model", value: model.rawValue)
        form.addField(name: "response_format", value: "json")
        if let lang = language, !lang.isEmpty {
            form.addField(name: "language", value: lang)
        }
        if !keyterms.isEmpty {
            let prompt = Self.clampPrompt(keyterms: keyterms)
            if !prompt.isEmpty {
                form.addField(name: "prompt", value: prompt)
            }
        }
        form.addFile(name: "file",
                     filename: audioURL.lastPathComponent,
                     mimeType: "audio/wav",
                     data: audioData)
        let body = form.finalize()

        let (data, response) = try await URLSession.shared.upload(for: request, from: body)
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

        struct Response: Decodable { let text: String? }
        let decoded: Response
        do {
            decoded = try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw TranscriptionError.invalidResponse
        }

        return TranscriptionResult(
            text: decoded.text ?? "",
            providerModelLabel: model.rawValue,
            audioSeconds: 0)
    }

    /// OpenAI limits the `prompt` field to roughly 224 tokens.
    /// We budget by characters (~4 chars/token) and truncate.
    private static func clampPrompt(keyterms: [String]) -> String {
        let maxChars = 800 // conservative
        var accum = ""
        for term in keyterms {
            let piece = accum.isEmpty ? term : ", \(term)"
            if accum.count + piece.count > maxChars { break }
            accum += piece
        }
        return accum
    }
}

struct MultipartFormBuilder {
    let boundary: String
    private var data = Data()

    init(boundary: String) {
        self.boundary = boundary
    }

    mutating func addField(name: String, value: String) {
        data.append("--\(boundary)\r\n")
        data.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
        data.append("\(value)\r\n")
    }

    mutating func addFile(name: String, filename: String, mimeType: String, data fileData: Data) {
        data.append("--\(boundary)\r\n")
        data.append("Content-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\n")
        data.append("Content-Type: \(mimeType)\r\n\r\n")
        data.append(fileData)
        data.append("\r\n")
    }

    mutating func finalize() -> Data {
        data.append("--\(boundary)--\r\n")
        return data
    }
}

private extension Data {
    mutating func append(_ string: String) {
        if let d = string.data(using: .utf8) {
            append(d)
        }
    }
}
