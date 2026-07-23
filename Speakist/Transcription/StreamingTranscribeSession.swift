import Foundation

/// A single real-time streaming transcription over a WebSocket to the
/// Speakist Worker's `/api/transcribe/ws` endpoint.
///
/// Lifecycle, driven by ShortcutManager + TranscriptionService:
///   1. `open()` at record-start — connects the socket and starts the
///      receive loop while the audio engine is still warming up.
///   2. `sendPCM(_:)` from the audio tap — streams 16 kHz mono linear16
///      frames as the user speaks. Thread-safe (called off the audio
///      thread); `URLSessionWebSocketTask.send` is safe from any thread.
///   3. `finishAndAwaitResult()` at key-release — tells the Worker to flush
///      Deepgram's final results, then awaits the terminal `result` message
///      and returns it as a `TranscriptionResult`.
///
/// The Worker runs the exact same polish + debit tail as the batch route,
/// so the result shape matches `SpeakistTranscribeClient`. On any transport
/// failure the caller (`StreamingTranscribeClient`) falls back to the batch
/// upload of the WAV the recorder wrote in parallel.
///
/// `@unchecked Sendable`: the receive loop and `finishAndAwaitResult` run on
/// different threads; all shared mutable state is guarded by `lock`.
final class StreamingTranscribeSession: NSObject, @unchecked Sendable {
    private let apiBaseURL: URL
    private let bearerToken: String
    let transcriptionClientId: String
    private let language: String?
    private let keyterms: [String]
    private let replaceRules: [ReplaceRule]
    private let dictation: Bool
    private let fillerWords: Bool
    private let measurements: Bool
    private let profanityFilter: Bool
    private let detectLanguage: Bool
    private let polishSkip: Bool

    private var task: URLSessionWebSocketTask?

    private let lock = NSLock()
    /// Set once, when the terminal message (or a failure) arrives. Any
    /// caller awaiting in `finishAndAwaitResult` is resumed with this.
    private var outcome: Result<TranscriptionResult, Error>?
    private var continuation: CheckedContinuation<TranscriptionResult, Error>?
    private var finished = false

    init(apiBaseURL: URL,
         bearerToken: String,
         transcriptionClientId: String,
         language: String?,
         keyterms: [String],
         replaceRules: [ReplaceRule],
         dictation: Bool,
         fillerWords: Bool,
         measurements: Bool,
         profanityFilter: Bool,
         detectLanguage: Bool,
         polishSkip: Bool) {
        self.apiBaseURL = apiBaseURL
        self.bearerToken = bearerToken
        self.transcriptionClientId = transcriptionClientId
        self.language = language
        self.keyterms = keyterms
        self.replaceRules = replaceRules
        self.dictation = dictation
        self.fillerWords = fillerWords
        self.measurements = measurements
        self.profanityFilter = profanityFilter
        self.detectLanguage = detectLanguage
        self.polishSkip = polishSkip
    }

    // MARK: - Open

    /// Build the wss URL, open the socket, and start receiving. Safe to
    /// call once. If the URL can't be built the session is left in a
    /// failed state so `finishAndAwaitResult` throws (→ batch fallback).
    func open() {
        guard let url = makeURL() else {
            complete(.failure(TranscriptionError.invalidResponse))
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        // The upgrade request carries the same bearer the batch route uses.
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")

        let task = URLSession.shared.webSocketTask(with: request)
        self.task = task
        task.resume()
        receiveLoop()
    }

    private func makeURL() -> URL? {
        guard var comps = URLComponents(url: apiBaseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        // https → wss, http → ws (local dev).
        comps.scheme = (comps.scheme == "http") ? "ws" : "wss"
        comps.path = "/api/transcribe/ws"

        var q: [URLQueryItem] = [URLQueryItem(name: "tid", value: transcriptionClientId)]
        if let language, !language.isEmpty {
            q.append(URLQueryItem(name: "language", value: language))
        }
        if detectLanguage { q.append(URLQueryItem(name: "detect_language", value: "true")) }
        if dictation { q.append(URLQueryItem(name: "dictation", value: "true")) }
        if fillerWords { q.append(URLQueryItem(name: "filler_words", value: "true")) }
        if measurements { q.append(URLQueryItem(name: "measurements", value: "true")) }
        if profanityFilter { q.append(URLQueryItem(name: "profanity_filter", value: "true")) }
        if polishSkip { q.append(URLQueryItem(name: "polish_skip", value: "true")) }
        let validKeyterms = keyterms.filter { !$0.isEmpty }
        if !validKeyterms.isEmpty {
            q.append(URLQueryItem(name: "keyterms", value: validKeyterms.joined(separator: ",")))
        }
        let replace = replaceRules
            .filter { $0.isValid }
            .prefix(200)
            .map { "\($0.find):\($0.replacement)" }
            .joined(separator: ";")
        if !replace.isEmpty {
            q.append(URLQueryItem(name: "replace", value: replace))
        }
        comps.queryItems = q
        return comps.url
    }

    // MARK: - Send

    /// Stream one linear16 PCM frame. Fire-and-forget: send errors just
    /// mean the socket is gone, which surfaces on the receive side and
    /// triggers the batch fallback at finish time.
    func sendPCM(_ data: Data) {
        task?.send(.data(data)) { _ in }
    }

    // MARK: - Finish

    /// Signal end-of-audio to the Worker and await the terminal result.
    /// Idempotent — a second call returns the same cached outcome. Throws
    /// on any transport failure or a server `error` message; the caller
    /// falls back to the batch upload.
    func finishAndAwaitResult(timeout: TimeInterval = 25) async throws -> TranscriptionResult {
        // Ask the Worker (→ Deepgram) to flush final results.
        task?.send(.string("{\"type\":\"CloseStream\"}")) { _ in }

        return try await withThrowingTaskGroup(of: TranscriptionResult.self) { group in
            group.addTask { [weak self] in
                guard let self else { throw TranscriptionError.canceled }
                return try await self.awaitOutcome()
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                throw TranscriptionError.network("Streaming result timed out")
            }
            defer { group.cancelAll() }
            guard let result = try await group.next() else {
                throw TranscriptionError.canceled
            }
            return result
        }
    }

    private func awaitOutcome() async throws -> TranscriptionResult {
        try await withCheckedThrowingContinuation { cont in
            lock.lock()
            if let outcome {
                lock.unlock()
                cont.resume(with: outcome)
                return
            }
            continuation = cont
            lock.unlock()
        }
    }

    func cancel() {
        task?.cancel(with: .goingAway, reason: nil)
        complete(.failure(TranscriptionError.canceled))
    }

    // MARK: - Receive loop

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                // Socket closed or errored. If we haven't already produced
                // a result, this is a failure → batch fallback.
                self.complete(.failure(TranscriptionError.network(error.localizedDescription)))
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleServerMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleServerMessage(text)
                    }
                @unknown default:
                    break
                }
                // Keep receiving until a terminal message completes us.
                if !self.isCompleted { self.receiveLoop() }
            }
        }
    }

    private func handleServerMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let msg = try? JSONDecoder().decode(ServerMessage.self, from: data) else {
            return
        }
        switch msg.type {
        case "result":
            let result = TranscriptionResult(
                text: msg.text ?? "",
                rawText: msg.rawText,
                providerModelLabel: msg.model ?? "auto",
                audioSeconds: msg.audioSeconds ?? 0
            )
            complete(.success(result))
        case "error":
            if msg.error == "insufficient_credit" {
                complete(.failure(SpeakistAPIClient.Error.insufficientCredit))
            } else {
                complete(.failure(TranscriptionError.network(msg.error ?? "stream_error")))
            }
        case "transcript":
            // Interim/final segment — reserved for a live HUD. Not consumed
            // yet; the authoritative transcript is the terminal `result`.
            break
        default:
            break
        }
    }

    private var isCompleted: Bool {
        lock.lock(); defer { lock.unlock() }
        return outcome != nil
    }

    /// Resolve the session exactly once, waking any awaiting caller.
    private func complete(_ result: Result<TranscriptionResult, Error>) {
        lock.lock()
        if outcome != nil {
            lock.unlock()
            return
        }
        outcome = result
        let cont = continuation
        continuation = nil
        lock.unlock()

        cont?.resume(with: result)
        // Close the socket once we're done with it.
        if !finished {
            finished = true
            task?.cancel(with: .normalClosure, reason: nil)
        }
    }

    private struct ServerMessage: Decodable {
        let type: String
        let text: String?
        let rawText: String?
        let audioSeconds: Double?
        let provider: String?
        let model: String?
        let polishApplied: Bool?
        let polishErrorReason: String?
        let usageEventId: String?
        let newBalanceMillicents: Int?
        let duplicate: Bool?
        let error: String?
        let balanceMillicents: Int?
        // transcript messages
        let isFinal: Bool?
    }
}
