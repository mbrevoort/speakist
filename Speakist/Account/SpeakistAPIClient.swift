import Foundation

/// HTTP client for the speakist.ai backend. One method per endpoint —
/// intentionally low-level; higher layers compose them.
///
/// Auth: an optional bearer token is injected via `tokenProvider`, a closure
/// invoked per request so token rotation (sign-in/out) is visible immediately
/// without re-plumbing. Device-code endpoints (`requestDeviceCodes`,
/// `pollDeviceAuth`) explicitly skip the bearer header since they're how we
/// obtain one in the first place.
///
/// Errors: each call returns typed errors. Network failures map to
/// `.network`; non-2xx responses surface as `.server(status, body)`;
/// deliberate app states (not signed in, 402 insufficient credit) surface
/// as their specific cases so callers can branch on them without parsing
/// body text.
@MainActor
final class SpeakistAPIClient {
    enum Error: Swift.Error, CustomStringConvertible {
        case notSignedIn
        case badResponse
        case server(status: Int, body: String?)
        case network(underlying: Swift.Error)
        case insufficientCredit
        case devicePending
        case deviceExpired

        var description: String {
            switch self {
            case .notSignedIn: return "Not signed in"
            case .badResponse: return "Unexpected response"
            case .server(let s, let b): return "Server error \(s): \(b ?? "")"
            case .network(let e): return "Network error: \(e.localizedDescription)"
            case .insufficientCredit: return "Out of credit — top up to continue"
            case .devicePending: return "Waiting for web approval"
            case .deviceExpired: return "Device code expired"
            }
        }
    }

    let baseURL: URL
    private let tokenProvider: @MainActor () -> String?
    private let session: URLSession

    init(baseURL: URL,
         tokenProvider: @escaping @MainActor () -> String?,
         session: URLSession = .shared) {
        self.baseURL = baseURL
        self.tokenProvider = tokenProvider
        self.session = session
    }

    // MARK: - Device-code sign-in

    struct DeviceStartResponse: Decodable {
        let userCode: String
        let deviceCode: String
        let verificationURL: String
        let verificationURLWithCode: String
        let interval: Int
        let expiresIn: Int

        enum CodingKeys: String, CodingKey {
            case userCode = "user_code"
            case deviceCode = "device_code"
            case verificationURL = "verification_url"
            case verificationURLWithCode = "verification_url_with_code"
            case interval, expiresIn = "expires_in"
        }
    }

    func requestDeviceCodes(deviceName: String?, platform: String?) async throws -> DeviceStartResponse {
        var body: [String: Any] = [:]
        if let name = deviceName, !name.isEmpty { body["deviceName"] = name }
        // Tell the server which platform initiated the flow so the
        // /link page can render "Code from your Mac" vs "Code from
        // your iPhone" instead of always saying "Mac". Server-side
        // validates against a known enum; unknown values are dropped
        // and the page falls back to a generic "your device" label.
        if let platform = platform, !platform.isEmpty { body["platform"] = platform }
        return try await perform(
            path: "/api/device/start",
            method: "POST",
            body: body.isEmpty ? nil : body,
            auth: false
        )
    }

    struct DevicePollResponse: Decodable {
        let status: String
        let accessToken: String?

        enum CodingKeys: String, CodingKey {
            case status
            case accessToken = "access_token"
        }
    }

    /// Polls the device endpoint. Returns `.accessToken` once approved, or
    /// throws `.devicePending` / `.deviceExpired` for the respective cases.
    func pollDeviceAuth(deviceCode: String) async throws -> String {
        let (data, response) = try await rawRequest(
            path: "/api/device/poll",
            method: "POST",
            body: ["device_code": deviceCode],
            auth: false
        )
        let http = response as? HTTPURLResponse
        guard let http else { throw Error.badResponse }

        if http.statusCode == 410 { throw Error.deviceExpired }
        if http.statusCode != 200 {
            throw Error.server(status: http.statusCode, body: String(data: data, encoding: .utf8))
        }

        let decoded = try decode(DevicePollResponse.self, from: data)
        switch decoded.status {
        case "authorized":
            guard let token = decoded.accessToken else { throw Error.badResponse }
            return token
        case "pending":
            throw Error.devicePending
        default:
            throw Error.badResponse
        }
    }

    // MARK: - Deepgram short-lived token

    struct DeepgramTokenResponse: Decodable {
        let key: String
        let expiresAt: String
        let source: String

        enum CodingKeys: String, CodingKey {
            case key
            case expiresAt = "expires_at"
            case source
        }
    }

    /// Requests a short-lived Deepgram key scoped to this user's org.
    /// Auto-translates HTTP 402 to `.insufficientCredit`.
    func mintDeepgramToken() async throws -> DeepgramTokenResponse {
        let (data, response) = try await rawRequest(
            path: "/api/deepgram/token",
            method: "POST",
            body: [:] as [String: Any],
            auth: true
        )
        guard let http = response as? HTTPURLResponse else { throw Error.badResponse }
        switch http.statusCode {
        case 200: return try decode(DeepgramTokenResponse.self, from: data)
        case 401: throw Error.notSignedIn
        case 402: throw Error.insufficientCredit
        default: throw Error.server(status: http.statusCode, body: String(data: data, encoding: .utf8))
        }
    }

    // MARK: - Identity

    struct MeResponse: Decodable {
        let id: String
        let email: String
        let displayName: String?
        let isSuperAdmin: Bool
        let org: OrgInfo?
        let polish: PolishInfo?

        struct OrgInfo: Decodable {
            let id: String
            let name: String
            let slug: String
            let role: String
            let isComped: Bool
            let balanceMillicents: Int

            enum CodingKeys: String, CodingKey {
                case id, name, slug, role
                case isComped = "is_comped"
                case balanceMillicents = "balance_millicents"
            }
        }

        struct PolishInfo: Decodable {
            let enabled: Bool
            /// One of the two modes the server supports. Older servers
            /// that haven't shipped the mode column yet don't include
            /// this field — defaultMode() handles the missing case.
            let mode: PolishMode
            /// The currently-effective prompt (custom if set, else the
            /// server default for the active mode).
            let systemPrompt: String
            /// True when `systemPrompt` is a user-set override; false when
            /// it's the baked-in server default for the current mode.
            /// Distinguishes "user customized and happens to match default"
            /// from "user hasn't customized yet" in the Settings editor.
            let isCustom: Bool
            /// Server's current mode-specific default — shown as
            /// read-only context under the editor so users know what
            /// they're overriding.
            let defaultPrompt: String

            enum CodingKeys: String, CodingKey {
                case enabled, mode
                case systemPrompt = "system_prompt"
                case isCustom = "is_custom"
                case defaultPrompt = "default_prompt"
            }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                self.enabled = try c.decode(Bool.self, forKey: .enabled)
                // Tolerate older servers that don't return `mode`. Default
                // to the conservative mode so the client UI shows a sane
                // selection until the next /api/me sync after the server
                // upgrade lands.
                self.mode = (try? c.decode(PolishMode.self, forKey: .mode)) ?? .prescriptive
                self.systemPrompt = try c.decode(String.self, forKey: .systemPrompt)
                self.isCustom = try c.decode(Bool.self, forKey: .isCustom)
                self.defaultPrompt = try c.decode(String.self, forKey: .defaultPrompt)
            }
        }

        enum CodingKeys: String, CodingKey {
            case id, email, org, polish
            case displayName = "display_name"
            case isSuperAdmin = "is_super_admin"
        }
    }

    /// Who am I? Called after sign-in (for the Settings "Signed in as …"
    /// line) and on launch-with-existing-token (to rehydrate state).
    func fetchMe() async throws -> MeResponse {
        try await perform(path: "/api/me", method: "GET", body: nil, auth: true)
    }

    /// Permanently delete the signed-in user's account. The server
    /// cascades the user's data (vocabulary, sessions, sole-member
    /// orgs, etc.); the caller is responsible for clearing the local
    /// keychain token after a 200. Required for App Review compliance
    /// on iOS (5.1.1(v) — apps that allow account creation must allow
    /// in-app account deletion).
    func deleteAccount() async throws {
        let (data, response) = try await rawRequest(
            path: "/api/me",
            method: "DELETE",
            body: nil,
            auth: true
        )
        guard let http = response as? HTTPURLResponse else { throw Error.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw Error.notSignedIn }
            throw Error.server(status: http.statusCode, body: String(data: data, encoding: .utf8))
        }
    }

    // MARK: - Polish prefs

    /// Two server-side polish prompt variants. `intuitive` runs the
    /// intent-aware prompt that applies explicit self-corrections
    /// ("I mean…", "scratch that…") and fixes obvious slips.
    /// `prescriptive` is conservative — only punctuation, capitalization,
    /// and clear grammar fixes; never touches meaning. The server's
    /// migration 0010 promotes existing polish-enabled users to
    /// `intuitive` to preserve their current behavior; new users default
    /// to `prescriptive`.
    enum PolishMode: String, Codable, CaseIterable, Identifiable, Sendable {
        case intuitive
        case prescriptive

        var id: String { rawValue }

        var displayName: String {
            switch self {
            case .intuitive: return "Intuitive"
            case .prescriptive: return "Prescriptive"
            }
        }
    }

    struct PolishPrefsResponse: Decodable {
        let enabled: Bool
        let mode: PolishMode
        let systemPrompt: String
        let isCustom: Bool
        let defaultPrompt: String

        enum CodingKeys: String, CodingKey {
            case enabled, mode
            case systemPrompt = "system_prompt"
            case isCustom = "is_custom"
            case defaultPrompt = "default_prompt"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.enabled = try c.decode(Bool.self, forKey: .enabled)
            self.mode = (try? c.decode(PolishMode.self, forKey: .mode)) ?? .prescriptive
            self.systemPrompt = try c.decode(String.self, forKey: .systemPrompt)
            self.isCustom = try c.decode(Bool.self, forKey: .isCustom)
            self.defaultPrompt = try c.decode(String.self, forKey: .defaultPrompt)
        }
    }

    /// PATCH-style update of the user's polish prefs. Each parameter is
    /// independently optional:
    ///   * `enabled = nil`        → don't touch the toggle
    ///   * `mode = nil`           → don't touch the mode
    ///   * `systemPrompt = nil`   → don't touch the prompt
    ///   * `systemPrompt = .null` → explicitly clear the custom prompt
    ///                              (revert to the active mode's default)
    ///   * `systemPrompt = .value(s)` → set a custom prompt
    ///
    /// Returns the post-save state so callers can refresh their local cache
    /// without a follow-up GET.
    func updatePolish(enabled: Bool?,
                      mode: PolishMode? = nil,
                      systemPrompt: OptionalValue<String>?) async throws -> PolishPrefsResponse {
        var body: [String: Any] = [:]
        if let enabled { body["enabled"] = enabled }
        if let mode { body["mode"] = mode.rawValue }
        if let systemPrompt {
            switch systemPrompt {
            case .value(let s): body["system_prompt"] = s
            case .null: body["system_prompt"] = NSNull()
            }
        }
        return try await perform(path: "/api/me/polish", method: "PUT", body: body, auth: true)
    }

    /// Helper enum so callers can distinguish "omit this field" (`nil` at
    /// the `updatePolish(systemPrompt:)` call site) from "explicitly
    /// clear the value" (`.null`).
    enum OptionalValue<T> {
        case value(T)
        case null
    }

    // MARK: - Usage reporting

    struct UsageResponse: Decodable {
        let ok: Bool
        let duplicate: Bool?
        let newBalanceMillicents: Int?
        let autoTopupTriggered: Bool?

        enum CodingKeys: String, CodingKey {
            case ok, duplicate
            case newBalanceMillicents = "newBalanceMillicents"
            case autoTopupTriggered = "autoTopupTriggered"
        }
    }

    /// Reports a completed transcription to the backend so the ledger debits.
    /// Safe to retry with the same `transcriptionClientId` — the server
    /// dedupes on that.
    func reportUsage(transcriptionClientId: String,
                     wordCount: Int,
                     audioMs: Int?,
                     model: String) async throws -> UsageResponse {
        var body: [String: Any] = [
            "transcriptionClientId": transcriptionClientId,
            "wordCount": wordCount,
            "model": model
        ]
        if let audioMs { body["audioMs"] = audioMs }
        return try await perform(path: "/api/usage", method: "POST", body: body, auth: true)
    }

    // MARK: - Vocabulary sync

    struct VocabEntryWire: Codable {
        let from: String
        let to: String
        let count: Int?
        let isProperNoun: Bool?
        /// Which surfaces this vocab entry affects. See server's
        /// /api/vocabulary route + migration 0021 for the full
        /// rationale; in short:
        ///   - "local" → stored + shown in Settings, never sent to STT
        ///   - "stt"   → sent to the upstream STT provider as keyterm
        ///               bias + replace=find:replacement rule
        /// Optional on the wire so older Mac builds (no field) keep
        /// syncing; absence means "server default" which is "local"
        /// for new rows and the value migration 0021 set for legacy
        /// rows.
        let appliesTo: String?
        let lastSeen: String?
        let updatedAt: String?
        let deleted: Bool?

        enum CodingKeys: String, CodingKey {
            case from, to, count
            case isProperNoun = "is_proper_noun"
            case appliesTo = "applies_to"
            case lastSeen = "last_seen"
            case updatedAt = "updated_at"
            case deleted
        }
    }

    struct VocabListResponse: Decodable {
        let entries: [VocabEntryWire]
        let serverTime: String

        enum CodingKeys: String, CodingKey {
            case entries
            case serverTime = "server_time"
        }
    }

    func fetchVocabulary(since: Date? = nil) async throws -> VocabListResponse {
        var path = "/api/vocabulary"
        if let since {
            let iso = ISO8601DateFormatter().string(from: since)
            path += "?since=\(iso.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? iso)"
        }
        return try await perform(path: path, method: "GET", body: nil, auth: true)
    }

    struct VocabUpsertResponse: Decodable {
        let ok: Bool
        let processed: Int
    }

    func pushVocabulary(entries: [VocabEntryWire]) async throws -> VocabUpsertResponse {
        try await perform(
            path: "/api/vocabulary",
            method: "POST",
            body: ["entries": entries.map { $0.asDict() }],
            auth: true
        )
    }

    // MARK: - Feedback ("Report bad transcription")

    /// Categorization the user picks (or doesn't) when reporting a
    /// bad transcription. String-typed to match the server's
    /// failure_kind column verbatim.
    enum FeedbackKind: String {
        case wrongWord = "wrong_word"
        case punctuation = "punctuation"
        case both = "both"
        case other = "other"
    }

    struct FeedbackResponse: Decodable {
        let id: String
        let status: String
    }

    /// Per-request context snapshot sent alongside a feedback submission.
    /// Mirrors the SpeakistTranscribeClient request shape so the bench /
    /// evaluation pipeline can replay the audio against the same provider
    /// config the user had at recording time. Encoded as a JSON object
    /// in the `transcription_options` multipart field; the server stores
    /// it as a forward-compatible blob (no schema migration when a new
    /// flag is added on either side).
    struct TranscriptionOptionsPayload: Encodable {
        var dictation: Bool
        var fillerWords: Bool
        var measurements: Bool
        var profanityFilter: Bool
        var detectLanguage: Bool
        /// `find:replacement` pairs sent on the X-Replace header. Encoded
        /// as objects rather than strings so the server-side reader can
        /// distinguish "find" from "replacement" without re-parsing.
        var replaceRules: [Rule]

        struct Rule: Encodable {
            var find: String
            var replacement: String
        }
    }

    /// Submit a "Report bad transcription" payload to the server.
    /// Multipart so the optional audio attachment streams cleanly.
    /// Returns the server-assigned feedback id on success.
    ///
    /// `audio` is nil when the user opted out of sharing audio with
    /// the report; the server still accepts the row and stores the
    /// texts. `audioContentType` should be `audio/wav` for our
    /// recordings — pass through whatever Content-Type the file's
    /// extension corresponds to if you ever swap encodings.
    ///
    /// `language`, `keyterms`, and `transcriptionOptions` snapshot the
    /// per-request context active at the time the user submits the
    /// report. They're caller-time values rather than recording-time
    /// values — vocabulary + option toggles are stable enough across
    /// the seconds-to-hours report-after-recording window that the
    /// drift is usually zero, and the alternative (snapshotting into
    /// TranscriptionEntry at recording time) would touch a lot more
    /// surface. Future enhancement.
    func submitFeedback(
        transcriptionClientId: String,
        rawText: String,
        polishedText: String,
        expectedText: String,
        failureKind: FeedbackKind?,
        userNote: String?,
        audio: Data?,
        audioContentType: String = "audio/wav",
        language: String? = nil,
        keyterms: [String]? = nil,
        transcriptionOptions: TranscriptionOptionsPayload? = nil
    ) async throws -> FeedbackResponse {
        guard let url = URL(string: "/api/feedback", relativeTo: baseURL) else {
            throw Error.badResponse
        }
        guard let token = tokenProvider(), !token.isEmpty else {
            throw Error.notSignedIn
        }

        // Build a multipart body by hand. URLSession doesn't ship a
        // multipart helper and pulling in Alamofire just for this
        // single call site is overkill.
        let boundary = "speakist-feedback-\(UUID().uuidString)"
        var body = Data()

        func appendField(name: String, value: String) {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append(
                "Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n"
                    .data(using: .utf8)!)
            body.append(value.data(using: .utf8) ?? Data())
            body.append("\r\n".data(using: .utf8)!)
        }

        appendField(name: "transcription_client_id", value: transcriptionClientId)
        appendField(name: "raw_text", value: rawText)
        appendField(name: "polished_text", value: polishedText)
        appendField(name: "expected_text", value: expectedText)
        if let failureKind {
            appendField(name: "failure_kind", value: failureKind.rawValue)
        }
        if let userNote, !userNote.isEmpty {
            appendField(name: "user_note", value: userNote)
        }
        if let language, !language.isEmpty {
            appendField(name: "language", value: language)
        }
        if let keyterms {
            // Always send when caller supplied the array — even an empty
            // [] is meaningful (it says "user has no vocab in scope"),
            // which is distinguishable on the server from "client
            // omitted the field" (older builds).
            if let data = try? JSONEncoder().encode(keyterms),
               let json = String(data: data, encoding: .utf8) {
                appendField(name: "keyterms", value: json)
            }
        }
        if let transcriptionOptions {
            if let data = try? JSONEncoder().encode(transcriptionOptions),
               let json = String(data: data, encoding: .utf8) {
                appendField(name: "transcription_options", value: json)
            }
        }
        if let audio {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append(
                "Content-Disposition: form-data; name=\"audio\"; filename=\"recording.wav\"\r\n"
                    .data(using: .utf8)!)
            body.append(
                "Content-Type: \(audioContentType)\r\n\r\n".data(using: .utf8)!)
            body.append(audio)
            body.append("\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        // Audio uploads can take a moment on slow links; bigger budget
        // than the JSON path's 15s but not unbounded.
        request.timeoutInterval = 60
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(
            "multipart/form-data; boundary=\(boundary)",
            forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = body

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw Error.network(underlying: error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw Error.badResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw Error.notSignedIn }
            throw Error.server(
                status: http.statusCode,
                body: String(data: data, encoding: .utf8))
        }
        return try decode(FeedbackResponse.self, from: data)
    }

    // MARK: - Internals

    /// Decodes a JSON response into `T`. Throws `.badResponse` on non-2xx.
    private func perform<T: Decodable>(
        path: String,
        method: String,
        body: Any?,
        auth: Bool
    ) async throws -> T {
        let (data, response) = try await rawRequest(path: path, method: method, body: body, auth: auth)
        guard let http = response as? HTTPURLResponse else { throw Error.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw Error.notSignedIn }
            throw Error.server(status: http.statusCode, body: String(data: data, encoding: .utf8))
        }
        return try decode(T.self, from: data)
    }

    private func rawRequest(
        path: String,
        method: String,
        body: Any?,
        auth: Bool
    ) async throws -> (Data, URLResponse) {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw Error.badResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if auth {
            guard let token = tokenProvider(), !token.isEmpty else {
                throw Error.notSignedIn
            }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        }

        do {
            return try await session.data(for: request)
        } catch {
            throw Error.network(underlying: error)
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            Logger.shared.warn("decode \(String(describing: T.self)) failed: \(error.localizedDescription)")
            throw Error.badResponse
        }
    }
}

private extension SpeakistAPIClient.VocabEntryWire {
    func asDict() -> [String: Any] {
        var d: [String: Any] = ["from": from, "to": to]
        if let count { d["count"] = count }
        if let isProperNoun { d["is_proper_noun"] = isProperNoun }
        if let appliesTo { d["applies_to"] = appliesTo }
        if let lastSeen { d["last_seen"] = lastSeen }
        if let deleted { d["deleted"] = deleted }
        return d
    }
}
