import Foundation

/// TranscriptionClient that POSTs audio to the Speakist Worker's
/// /api/transcribe endpoint instead of calling the provider directly.
///
/// This is the "Phase A" path — instead of the Mac minting a Deepgram
/// ephemeral key and uploading audio to api.deepgram.com, we upload the
/// audio to our Worker, which forwards to the chosen provider, debits
/// credits inline, and returns the canonical transcription response.
///
/// Benefits:
///   * One HTTP request per transcription (was: mint → upload → report)
///   * No more separate /api/usage call — debit happens server-side
///   * Provider swap is a header change, not an app update
///   * Per-provider cost accounting uses the provider's reported duration,
///     not a Mac-computed word count approximation
///
/// Trade-off: audio bytes now transit our Worker. Privacy claim updated —
/// see README. Audio is never persisted; Worker streams it to the provider
/// and drops it on request end.
///
/// Gated behind `Preferences.useTranscribeProxy`: if off, TranscriptionService
/// falls back to the legacy DeepgramClient path.
@MainActor
struct SpeakistTranscribeClient: TranscriptionClient {
    let apiBaseURL: URL
    let bearerToken: String
    let transcriptionClientId: String

    // Deepgram-specific options — forwarded to the server as X-* headers.
    // The server's per-provider adapter maps them (or ignores them, for
    // providers that don't support the knob).
    let dictation: Bool
    let fillerWords: Bool
    let measurements: Bool
    let profanityFilter: Bool
    let detectLanguage: Bool
    let replaceRules: [ReplaceRule]

    // Provider + model are no longer chosen client-side — the Worker picks
    // based on the user's chosen language and the org's super-admin-set
    // allowed-models list. Pre-call labels report "auto" so audit rows
    // capture "we asked the server to decide"; post-call, the actual
    // (provider, model) the server picked is returned in
    // `TranscriptionResult.providerModelLabel` and is what gets recorded
    // in usage_events server-side.
    nonisolated var providerLabel: String { "auto" }
    nonisolated var modelLabel: String { "auto" }

    nonisolated func transcribe(audioURL: URL, keyterms: [String], language: String?) async throws -> TranscriptionResult {
        let audioMs = (try? FileManager.default.attributesOfItem(atPath: audioURL.path)[.size] as? Int)
            .flatMap { size in
                // 16 kHz mono Int16 WAV = 32_000 bytes/s → ms = size / 32
                // Rough hint only; the server uses the provider-reported
                // duration when it's available.
                size > 0 ? (size / 32) : nil
            } ?? 0

        guard let url = URL(string: "/api/transcribe", relativeTo: apiBaseURL) else {
            throw TranscriptionError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
        request.setValue(transcriptionClientId, forHTTPHeaderField: "X-Transcription-Id")
        request.setValue(String(audioMs), forHTTPHeaderField: "X-Audio-Ms")
        // Note: X-Provider-Hint / X-Model-Hint are intentionally NOT sent.
        // The server picks provider+model from X-Language and the org's
        // super-admin-configured allowed-models whitelist. Older builds
        // that send the hint headers are tolerated by the server (which
        // ignores them) so a forced upgrade isn't required.

        if let lang = language, !lang.isEmpty {
            request.setValue(lang, forHTTPHeaderField: "X-Language")
        }
        if !keyterms.isEmpty {
            // Comma-separated. Deepgram keyterms don't contain commas in
            // practice; if they do, the adapter will split wrong and that's
            // a correction-data hygiene issue, not a transport one.
            request.setValue(keyterms.joined(separator: ","),
                             forHTTPHeaderField: "X-Keyterms")
        }
        if dictation { request.setValue("true", forHTTPHeaderField: "X-Dictation") }
        if fillerWords { request.setValue("true", forHTTPHeaderField: "X-Filler-Words") }
        if measurements { request.setValue("true", forHTTPHeaderField: "X-Measurements") }
        if profanityFilter { request.setValue("true", forHTTPHeaderField: "X-Profanity-Filter") }
        if detectLanguage { request.setValue("true", forHTTPHeaderField: "X-Detect-Language") }

        if !replaceRules.isEmpty {
            // Semicolon-separated find:replacement pairs. Filter out the
            // same invalid cases DeepgramClient does so the server doesn't
            // forward malformed rules upstream.
            let header = replaceRules
                .filter { $0.isValid }
                .prefix(200)
                .map { "\($0.find):\($0.replacement)" }
                .joined(separator: ";")
            if !header.isEmpty {
                request.setValue(header, forHTTPHeaderField: "X-Replace")
            }
        }

        // Use uploadTask(fromFile:) semantics via `upload(for:fromFile:)` —
        // the audio streams from disk instead of being loaded into memory.
        // Important for long recordings; 5-min WAV = ~9.6 MB.
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.upload(for: request, fromFile: audioURL)
        } catch {
            throw TranscriptionError.network(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw TranscriptionError.invalidResponse
        }

        switch http.statusCode {
        case 200...299: break
        case 401, 403: throw TranscriptionError.authFailed
        case 402: throw SpeakistAPIClient.Error.insufficientCredit
        case 429: throw TranscriptionError.rateLimited
        case 504: throw TranscriptionError.network("Upstream timed out")
        default:
            let body = String(data: data, encoding: .utf8)
            throw TranscriptionError.serverError(http.statusCode, body)
        }

        let decoded: TranscribeResponse
        do {
            decoded = try JSONDecoder().decode(TranscribeResponse.self, from: data)
        } catch {
            throw TranscriptionError.invalidResponse
        }

        return TranscriptionResult(
            text: decoded.text,
            providerModelLabel: decoded.model,
            audioSeconds: decoded.audioSeconds
        )
    }

    private struct TranscribeResponse: Decodable {
        let text: String
        let audioSeconds: Double
        let provider: String
        let model: String
        let usageEventId: String?
        let newBalanceMillicents: Int?
        let duplicate: Bool?
    }
}
