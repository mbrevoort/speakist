import SwiftUI
import AVFoundation

/// "Report bad transcription" sheet for iOS, presented from the
/// History detail view. Mirrors the Mac sheet field-for-field — the
/// privacy contract and POST shape are identical so a feedback row
/// looks the same regardless of platform on the server.
///
/// Submission requires a `transcriptionClientId`; if the entry
/// predates the feedback feature (older HistoryEntries don't carry
/// it) the Report button is hidden in HistoryView so we don't get
/// here. Audio attachment is opt-in inside the sheet, regardless of
/// whether the archive still has it.
@MainActor
struct ReportFeedbackView: View {
    let entry: HistoryEntry
    let apiClient: SpeakistAPIClient

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var history: HistoryStore

    @State private var expectedText: String = ""
    @State private var failureKind: SpeakistAPIClient.FeedbackKind? = nil
    @State private var note: String = ""
    @State private var shareAudio: Bool = true

    @State private var player: AVAudioPlayer?
    @State private var isPlayingAudio: Bool = false

    @State private var isSubmitting: Bool = false
    @State private var errorMessage: String? = nil

    var body: some View {
        NavigationStack {
            Form {
                Section("What we transcribed") {
                    Text(entry.text.isEmpty ? "(empty)" : entry.text)
                        .font(.callout)
                }

                Section("What you actually meant") {
                    TextEditor(text: $expectedText)
                        .frame(minHeight: 100)
                }

                if hasArchivedAudio {
                    Section("Audio") {
                        HStack {
                            Button {
                                togglePlayback()
                            } label: {
                                Label(
                                    isPlayingAudio ? "Pause" : "Play",
                                    systemImage: isPlayingAudio ? "pause.fill" : "play.fill"
                                )
                            }
                            .buttonStyle(.bordered)
                            Spacer()
                        }
                        Toggle("Include the audio recording", isOn: $shareAudio)
                    }
                } else if entry.audioPath != nil {
                    // Audio path was set but the file is gone (pruned
                    // by the 24h archive). Be honest: the user can
                    // still submit a text-only report.
                    Section("Audio") {
                        Text("The audio recording is no longer available; you can still submit a text-only report.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("What kind of issue? (optional)") {
                    Picker("Kind", selection: $failureKind) {
                        Text("— pick one (optional) —").tag(nil as SpeakistAPIClient.FeedbackKind?)
                        Text("Wrong words").tag(SpeakistAPIClient.FeedbackKind?.some(.wrongWord))
                        Text("Punctuation / capitalization").tag(SpeakistAPIClient.FeedbackKind?.some(.punctuation))
                        Text("Both").tag(SpeakistAPIClient.FeedbackKind?.some(.both))
                        Text("Other").tag(SpeakistAPIClient.FeedbackKind?.some(.other))
                    }
                    .pickerStyle(.menu)
                }

                Section("Note (optional)") {
                    TextEditor(text: $note)
                        .frame(minHeight: 60)
                }

                Section {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "info.circle.fill")
                            .foregroundStyle(.tint)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("This sends \(shareAudio && hasArchivedAudio ? "the audio recording and " : "")the texts to Speakist so we can improve transcription accuracy.")
                            Text("Audio is only ever shared when you explicitly report a transcription. Your transcripts otherwise stay on this device.")
                                .foregroundStyle(.secondary)
                        }
                        .font(.caption)
                    }
                } footer: {
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Report bad transcription")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await submit() }
                    } label: {
                        if isSubmitting {
                            ProgressView()
                        } else {
                            Text("Send")
                        }
                    }
                    .disabled(isSubmitting || !canSubmit)
                }
            }
            .onAppear {
                if expectedText.isEmpty {
                    expectedText = entry.text
                }
            }
        }
    }

    // MARK: - Helpers

    private var hasArchivedAudio: Bool {
        guard let path = entry.audioPath else { return false }
        return FileManager.default.fileExists(atPath: path)
    }

    private var canSubmit: Bool {
        guard entry.transcriptionClientId != nil else { return false }
        return !expectedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func togglePlayback() {
        guard let path = entry.audioPath else { return }
        if isPlayingAudio {
            player?.pause()
            isPlayingAudio = false
            return
        }
        do {
            if player == nil {
                player = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: path))
            }
            player?.play()
            isPlayingAudio = true
        } catch {
            Logger.shared.warn("audio play failed: \(error.localizedDescription)")
        }
    }

    private func submit() async {
        errorMessage = nil
        guard let tcid = entry.transcriptionClientId else {
            errorMessage = "This entry can't be reported (missing tracking id)."
            return
        }
        isSubmitting = true
        defer { isSubmitting = false }

        var audioData: Data? = nil
        if shareAudio, let path = entry.audioPath {
            audioData = AudioArchive.readAudio(at: path)
            if audioData == nil {
                Logger.shared.info(
                    "ReportFeedback (iOS): audio not readable at \(path); proceeding text-only")
            }
        }

        // Per-request context snapshot. iOS doesn't (yet) expose
        // vocabulary or the transcribe-option toggles in settings —
        // SpeakistTranscribeClient on iOS calls /api/transcribe with no
        // X-Keyterms header and none of the X-* toggles. We send the
        // equivalent ([] keyterms + all-false options) explicitly here
        // so the feedback row reflects what iOS actually sent to the
        // server, rather than NULL (which would be ambiguous with
        // "older build that didn't report"). When iOS gains a vocab
        // store + settings UI, populate these from the same source
        // SpeakistTranscribeClient uses.
        let options = SpeakistAPIClient.TranscriptionOptionsPayload(
            dictation: false,
            fillerWords: false,
            measurements: false,
            profanityFilter: false,
            detectLanguage: false,
            replaceRules: []
        )

        do {
            let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
            _ = try await apiClient.submitFeedback(
                transcriptionClientId: tcid,
                rawText: entry.rawTranscript ?? entry.text,
                polishedText: entry.text,
                expectedText: expectedText.trimmingCharacters(in: .whitespacesAndNewlines),
                failureKind: failureKind,
                userNote: trimmedNote.isEmpty ? nil : trimmedNote,
                audio: audioData,
                language: nil,           // iOS sends no X-Language; server auto-detects.
                keyterms: [],            // iOS has no vocab store yet — see comment above.
                transcriptionOptions: options
            )
            history.markReported(id: entry.id)
            Analytics.shared.capture("feedback_submitted", properties: [
                "platform": "ios",
                "audio_shared": audioData != nil,
                "failure_kind": failureKind?.rawValue ?? "unspecified",
            ])
            dismiss()
        } catch SpeakistAPIClient.Error.notSignedIn {
            errorMessage = "You're signed out. Sign in and try again."
        } catch SpeakistAPIClient.Error.server(let status, _) where status == 403 {
            errorMessage =
                "Your organization has disabled feedback submissions. Ask your admin to re-enable."
        } catch {
            errorMessage = "Couldn't send report. \(error.localizedDescription)"
        }
    }
}
