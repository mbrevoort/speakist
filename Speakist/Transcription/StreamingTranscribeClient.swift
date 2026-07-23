import Foundation

/// TranscriptionClient that finalizes an already-open streaming session.
///
/// Unlike the batch clients, this one does no work with `audioURL` on the
/// happy path — the audio was streamed to the Worker as the user spoke.
/// `transcribe()` just tells the session to flush and returns the terminal
/// result. The `audioURL` is used only for the fallback: if streaming fails
/// for any transport reason, we upload the WAV via the batch client, so a
/// flaky socket never costs the user their dictation.
///
/// A definitive server rejection (insufficient credit) is NOT retried via
/// batch — it would just 402 again — so it propagates unchanged for the
/// same out-of-credit UX the batch path shows.
struct StreamingTranscribeClient: TranscriptionClient {
    let session: StreamingTranscribeSession
    let fallback: SpeakistTranscribeClient

    nonisolated var providerLabel: String { "auto" }
    nonisolated var modelLabel: String { "auto" }

    nonisolated func transcribe(audioURL: URL, keyterms: [String], language: String?) async throws -> TranscriptionResult {
        do {
            return try await session.finishAndAwaitResult()
        } catch SpeakistAPIClient.Error.insufficientCredit {
            throw SpeakistAPIClient.Error.insufficientCredit
        } catch {
            Logger.shared.warn(
                "Streaming transcription failed (\(error.localizedDescription)); "
                + "falling back to batch upload")
            return try await fallback.transcribe(
                audioURL: audioURL, keyterms: keyterms, language: language)
        }
    }
}
