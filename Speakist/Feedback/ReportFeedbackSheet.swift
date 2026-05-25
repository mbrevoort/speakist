import SwiftUI
import AVFoundation

/// "Report bad transcription" sheet shown from the History DetailView.
///
/// Captures: what we transcribed (read-only), what the user actually
/// meant (editable, pre-filled with the entry's final text), an
/// optional kind dropdown, an optional note, and an opt-in to share
/// the audio recording. On submit, multiparts everything to
/// /api/feedback via the SpeakistAPIClient and stamps `reported_at`
/// on the local row so the row gets a Reported badge and the button
/// hides.
///
/// Privacy boundary surface: the disclosure copy makes the contract
/// explicit. Audio + texts are sent to Speakist support, used for
/// quality-control. Org admins can disable feedback for the whole
/// org (server returns 403 if disabled, surfaced as an error toast).
@MainActor
struct ReportFeedbackSheet: View {
    let entry: TranscriptionEntry
    let env: AppEnvironment

    @Environment(\.dismiss) private var dismiss

    @State private var expectedText: String = ""
    @State private var failureKind: SpeakistAPIClient.FeedbackKind? = nil
    @State private var note: String = ""
    @State private var shareAudio: Bool = true

    @State private var player: AVAudioPlayer?
    @State private var isPlayingAudio: Bool = false

    @State private var isSubmitting: Bool = false
    @State private var errorMessage: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    transcribedBox
                    expectedBox
                    if entry.audioPath != nil {
                        audioBox
                    }
                    kindPicker
                    noteField
                    disclosureBanner
                }
            }

            Divider()
            footer
        }
        .padding(20)
        .frame(width: 560)
        .frame(minHeight: 600, idealHeight: 680)
        .onAppear { expectedText = displayedFinal }
    }

    // MARK: - Sections

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Report bad transcription").font(.headline)
                Text("Help us improve Speakist by sharing what we got wrong.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    private var transcribedBox: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("What we transcribed").font(.subheadline.weight(.semibold))
            ScrollView {
                Text(displayedFinal.isEmpty ? "(empty)" : displayedFinal)
                    .font(.callout)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(minHeight: 60, maxHeight: 120)
            .background(
                RoundedRectangle(cornerRadius: 6).fill(Color(NSColor.textBackgroundColor))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6).stroke(Color(NSColor.separatorColor))
            )
        }
    }

    private var expectedBox: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("What you actually meant").font(.subheadline.weight(.semibold))
            TextEditor(text: $expectedText)
                .font(.callout)
                .frame(minHeight: 80, maxHeight: 160)
                .padding(4)
                .background(
                    RoundedRectangle(cornerRadius: 6).fill(Color(NSColor.textBackgroundColor))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6).stroke(Color(NSColor.separatorColor))
                )
        }
    }

    private var audioBox: some View {
        HStack(spacing: 8) {
            Button {
                togglePlayback()
            } label: {
                Label(isPlayingAudio ? "Pause" : "Play",
                      systemImage: isPlayingAudio ? "pause.fill" : "play.fill")
            }
            Toggle("Include the audio recording", isOn: $shareAudio)
                .toggleStyle(.checkbox)
            Spacer()
        }
        .font(.callout)
    }

    private var kindPicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("What kind of issue? (optional)").font(.subheadline.weight(.semibold))
            Picker("", selection: $failureKind) {
                Text("— pick one (optional) —").tag(nil as SpeakistAPIClient.FeedbackKind?)
                Text("Wrong words").tag(SpeakistAPIClient.FeedbackKind?.some(.wrongWord))
                Text("Punctuation / capitalization").tag(SpeakistAPIClient.FeedbackKind?.some(.punctuation))
                Text("Both").tag(SpeakistAPIClient.FeedbackKind?.some(.both))
                Text("Other").tag(SpeakistAPIClient.FeedbackKind?.some(.other))
            }
            .labelsHidden()
            .pickerStyle(.menu)
        }
    }

    private var noteField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Note (optional)").font(.subheadline.weight(.semibold))
            TextEditor(text: $note)
                .font(.callout)
                .frame(minHeight: 50, maxHeight: 80)
                .padding(4)
                .background(
                    RoundedRectangle(cornerRadius: 6).fill(Color(NSColor.textBackgroundColor))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6).stroke(Color(NSColor.separatorColor))
                )
        }
    }

    private var disclosureBanner: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle.fill").foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text("This sends \(shareAudio && entry.audioPath != nil ? "the audio recording and " : "")the texts to Speakist so we can improve transcription accuracy.")
                Text("Audio is only ever shared when you explicitly report a transcription. Your transcripts otherwise stay on this device.")
                    .foregroundStyle(.secondary)
            }
            .font(.caption)
            Spacer()
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 6).fill(Color.accentColor.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6).stroke(Color.accentColor.opacity(0.3))
        )
    }

    private var footer: some View {
        HStack(spacing: 8) {
            if let errorMessage {
                Text(errorMessage).font(.caption).foregroundStyle(.red).lineLimit(2)
            }
            Spacer()
            Button("Cancel") { dismiss() }
                .keyboardShortcut(.cancelAction)
            Button {
                Task { await submit() }
            } label: {
                if isSubmitting {
                    ProgressView().scaleEffect(0.7).frame(width: 80)
                } else {
                    Text("Send report").frame(width: 80)
                }
            }
            .keyboardShortcut(.defaultAction)
            .buttonStyle(.borderedProminent)
            .disabled(isSubmitting || !canSubmit)
        }
    }

    // MARK: - Helpers

    private var displayedFinal: String {
        let text = entry.finalTranscript.isEmpty ? entry.rawTranscript : entry.finalTranscript
        return text
    }

    private var canSubmit: Bool {
        !expectedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
        isSubmitting = true
        defer { isSubmitting = false }

        // Read audio bytes if we're sharing them. nil otherwise — the
        // server treats absence as "text-only report".
        var audioData: Data? = nil
        if shareAudio, let path = entry.audioPath {
            audioData = try? Data(contentsOf: URL(fileURLWithPath: path))
            if audioData == nil {
                Logger.shared.warn(
                    "ReportFeedback: audio path set but bytes unreadable at \(path); proceeding text-only")
            }
        }

        // Per-request context snapshot — same source-of-truth as
        // TranscriptionService.buildClient() / process() use when
        // building a real /api/transcribe call, so the values we record
        // match what the user actually had active. Caller-time values
        // (see SpeakistAPIClient.submitFeedback docs for the caveat;
        // for our typical "report within minutes" flow the drift is
        // ~zero).
        let keyterms = VocabularyBuilder.keyterms(from: env.correctionStore)
        let replaceRules = VocabularyBuilder.replaceRules(from: env.correctionStore)
        let options = SpeakistAPIClient.TranscriptionOptionsPayload(
            dictation: env.preferences.dictationMode,
            fillerWords: env.preferences.includeFillerWords,
            measurements: env.preferences.convertMeasurements,
            profanityFilter: env.preferences.maskProfanity,
            detectLanguage: env.preferences.autoDetectLanguage,
            replaceRules: replaceRules.map {
                .init(find: $0.find, replacement: $0.replacement)
            }
        )
        let language = env.preferences.language.isEmpty ? nil : env.preferences.language

        do {
            let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
            _ = try await env.apiClient.submitFeedback(
                transcriptionClientId: entry.id,
                rawText: entry.rawTranscript,
                polishedText: displayedFinal,
                expectedText: expectedText.trimmingCharacters(in: .whitespacesAndNewlines),
                failureKind: failureKind,
                userNote: trimmedNote.isEmpty ? nil : trimmedNote,
                audio: audioData,
                language: language,
                keyterms: keyterms,
                transcriptionOptions: options
            )
            env.historyStore.markReported(id: entry.id)
            Analytics.shared.capture("feedback_submitted", properties: [
                "platform": "mac",
                "audio_shared": audioData != nil,
                "failure_kind": failureKind?.rawValue ?? "unspecified",
                "keyterms_count": keyterms.count,
                "replace_rules_count": replaceRules.count,
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
