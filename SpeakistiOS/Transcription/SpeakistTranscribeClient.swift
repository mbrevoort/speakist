import Foundation

/// iOS-minimal variant of the Mac `SpeakistTranscribeClient`. Uploads a
/// 16 kHz mono Int16 WAV to the Speakist Worker's `/api/transcribe`
/// endpoint and returns the final polished transcript. The server
/// handles provider routing (Deepgram/Groq), credit debiting, and the
/// optional LLM polish pass server-side — so the client is just "upload
/// bytes, get text back".
///
/// Why a separate file instead of reusing the Mac version: the Mac impl
/// takes a full set of `ReplaceRule` / keyterm parameters sourced from
/// `CorrectionStore` + `VocabularyBuilder`. The iOS scaffold doesn't
/// carry the Mac's correction-learning loop yet, so every one of those
/// fields would be empty. Inlining a lean client here keeps the iOS
/// target free of the GRDB-backed `CorrectionStore` dependency chain
/// until there's a real reason to pull it across.
@MainActor
struct SpeakistTranscribeClient {
    let apiBaseURL: URL
    let bearerToken: String
    /// Opaque ID the client generates per-recording. Server dedupes on
    /// retries so a dropped connection + retry doesn't double-bill.
    let transcriptionClientId: String

    init(apiBaseURL: URL,
         bearerToken: String,
         transcriptionClientId: String = UUID().uuidString) {
        self.apiBaseURL = apiBaseURL
        self.bearerToken = bearerToken
        self.transcriptionClientId = transcriptionClientId
    }

    nonisolated func transcribe(audioURL: URL, language: String? = nil) async throws -> TranscriptionResult {
        let audioMs = (try? FileManager.default.attributesOfItem(atPath: audioURL.path)[.size] as? Int)
            .flatMap { size in size > 0 ? size / 32 : nil } ?? 0  // 16 kHz mono Int16 = 32 B/ms

        guard let url = URL(string: "/api/transcribe", relativeTo: apiBaseURL) else {
            throw TranscriptionError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        // 120s ceiling — `timeoutInterval` governs the full request
        // lifetime including the server's response wait, not just
        // connect. On slow cellular a 60-second WAV can easily take
        // 30-60s to upload, then the server pays another few seconds
        // for the Whisper round-trip. The previous 30s budget was
        // dropping legitimate uploads as TranscriptionError.network
        // before the transcript ever came back.
        request.timeoutInterval = 120
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
        request.setValue(transcriptionClientId, forHTTPHeaderField: "X-Transcription-Id")
        request.setValue(String(audioMs), forHTTPHeaderField: "X-Audio-Ms")
        // X-Provider-Hint / X-Model-Hint are not sent — the Worker picks
        // provider+model from the org's allowed-models list (configured
        // by super admin) and the X-Language hint below. English →
        // Groq Whisper Turbo by default; other languages → Whisper Large.
        if let language, !language.isEmpty {
            request.setValue(language, forHTTPHeaderField: "X-Language")
        }

        // Streams from disk so long recordings don't balloon memory
        // (a 5-minute WAV is ~9.6 MB).
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
        case 402: throw TranscriptionError.serverError(402, "Out of credit — top up to continue")
        case 429: throw TranscriptionError.rateLimited
        case 504: throw TranscriptionError.network("Upstream timed out")
        default:
            let body = String(data: data, encoding: .utf8)
            throw TranscriptionError.serverError(http.statusCode, body)
        }

        struct TranscribeResponse: Decodable {
            let text: String
            /// Pre-polish STT output. Optional in the Decodable layer so
            /// older Worker deployments (pre rawText-response change)
            /// don't fail to decode; downstream code falls back to
            /// `text` when this is nil.
            let rawText: String?
            let audioSeconds: Double
            let provider: String
            let model: String
        }
        let decoded: TranscribeResponse
        do {
            decoded = try JSONDecoder().decode(TranscribeResponse.self, from: data)
        } catch {
            throw TranscriptionError.invalidResponse
        }
        return TranscriptionResult(
            text: decoded.text,
            rawText: decoded.rawText,
            providerModelLabel: decoded.model,
            audioSeconds: decoded.audioSeconds
        )
    }
}
