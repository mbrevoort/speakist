import Foundation

struct CleanupResult {
    let text: String
    let inputTokens: Int
    let outputTokens: Int
    let model: String
}

struct CleanupClient: Sendable {
    let apiKey: String
    let model: CleanupModel

    func clean(rawTranscript: String, systemPrompt: String, corrections: [String: String]) async throws -> CleanupResult {
        var fullSystemPrompt = systemPrompt
        if !corrections.isEmpty {
            fullSystemPrompt += "\n\nKnown name and term corrections (apply literally where unambiguous):\n"
            for (from, to) in corrections {
                fullSystemPrompt += "- \"\(from)\" → \"\(to)\"\n"
            }
        }

        let url = URL(string: "https://api.openai.com/v1/chat/completions")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30

        let payload: [String: Any] = [
            "model": model.rawValue,
            "temperature": 0.2,
            "messages": [
                ["role": "system", "content": fullSystemPrompt],
                ["role": "user", "content": rawTranscript]
            ]
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: payload, options: [])

        let (data, response) = try await URLSession.shared.data(for: request)
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

        struct Response: Decodable {
            let choices: [Choice]
            let usage: Usage?
            struct Choice: Decodable {
                let message: Message
            }
            struct Message: Decodable {
                let content: String?
            }
            struct Usage: Decodable {
                let prompt_tokens: Int?
                let completion_tokens: Int?
            }
        }

        let decoded: Response
        do {
            decoded = try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw TranscriptionError.invalidResponse
        }
        let text = decoded.choices.first?.message.content ?? rawTranscript
        return CleanupResult(
            text: text.trimmingCharacters(in: .whitespacesAndNewlines),
            inputTokens: decoded.usage?.prompt_tokens ?? 0,
            outputTokens: decoded.usage?.completion_tokens ?? 0,
            model: model.rawValue)
    }
}
