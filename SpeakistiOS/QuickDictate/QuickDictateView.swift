import SwiftUI

/// Quick Dictate sheet. Presented modally from the home view's primary
/// CTA. Life cycle mirrors `QuickDictateController.Phase`:
///
///   preparing/recording → big mic icon + waveform + Stop button
///   transcribing        → spinner + "Transcribing…"
///   reviewing           → editable TextEditor + "Copy & close"
///   error               → message + "Try again" / "Close"
///
/// Auto-records on appear. User taps Stop when done speaking, edits if
/// needed, then taps Copy & close — clipboard is written, a history
/// entry is appended, and the sheet dismisses.
struct QuickDictateView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var controller: QuickDictateController

    init(history: HistoryStore, tokenProvider: @escaping () -> String?) {
        _controller = StateObject(wrappedValue: QuickDictateController(
            history: history,
            tokenProvider: tokenProvider
        ))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.speakistCream
                    .ignoresSafeArea()
                    .opacity(0.5)

                content
                    .padding()
            }
            .navigationTitle("Quick Dictate")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        controller.cancel()
                        dismiss()
                    }
                }
            }
        }
        .task { await controller.start() }
        .onChange(of: controller.phase) { _, newPhase in
            if case .done = newPhase { dismiss() }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch controller.phase {
        case .idle, .preparing:
            preparingView
        case .recording:
            recordingView
        case .transcribing:
            transcribingView
        case .reviewing:
            reviewingView
        case .error(let message):
            errorView(message: message)
        case .done:
            // Sheet is about to dismiss; render nothing.
            Color.clear
        }
    }

    private var preparingView: some View {
        VStack(spacing: 20) {
            ProgressView()
                .scaleEffect(1.4)
            Text("Preparing microphone…")
                .foregroundStyle(.secondary)
        }
    }

    private var recordingView: some View {
        VStack(spacing: 32) {
            Spacer()

            // Fixed-size frame so the pulsing ring doesn't reflow the
            // parent VStack — otherwise the "Listening…" label jumps
            // up and down with the user's voice. The ZStack is clipped
            // to a 320×320 slot; the ring grows/shrinks within.
            ZStack {
                // Outer level-driven ring. Inset from 320 to give the
                // ring room to grow without touching the frame edge.
                // `level` is 0…1 (already sqrt-curved in AudioRecorder);
                // we map that to an extra 160 points of diameter on top
                // of the 160-point baseline so a loud voice visibly
                // fills most of the slot.
                Circle()
                    .fill(.speakistPeach.opacity(0.16))
                    .frame(width: 160 + CGFloat(controller.level) * 160,
                           height: 160 + CGFloat(controller.level) * 160)
                    .animation(.spring(response: 0.18, dampingFraction: 0.55), value: controller.level)

                // Second ring, smaller so the stacked parallax makes
                // the effect feel more alive without any extra code.
                Circle()
                    .fill(.speakistPeach.opacity(0.28))
                    .frame(width: 150 + CGFloat(controller.level) * 90,
                           height: 150 + CGFloat(controller.level) * 90)
                    .animation(.spring(response: 0.25, dampingFraction: 0.6), value: controller.level)

                // Solid core stays rock-still so the icon centers on a
                // stable reference point rather than pumping with the
                // voice — clearer visual hierarchy.
                Circle()
                    .fill(.speakistPeach)
                    .frame(width: 140, height: 140)
                Image(systemName: "waveform")
                    .font(.system(size: 48, weight: .medium))
                    .foregroundStyle(.white)
                    .symbolEffect(.variableColor.iterative.reversing, options: .repeating)
            }
            .frame(width: 320, height: 320)

            Text("Listening…")
                .font(.title2.weight(.medium))

            Spacer()

            Button {
                Task { await controller.stop() }
            } label: {
                Label("Stop", systemImage: "stop.fill")
                    .font(.title3.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
            }
            .buttonStyle(.borderedProminent)
            .tint(.speakistPeach)
        }
    }

    private var transcribingView: some View {
        VStack(spacing: 20) {
            Spacer()
            ProgressView()
                .scaleEffect(1.4)
            Text("Transcribing…")
                .font(.title3)
                .foregroundStyle(.secondary)
            Spacer()
        }
    }

    private var reviewingView: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Review and edit")
                .font(.headline)
                .foregroundStyle(.secondary)

            TextEditor(text: $controller.editedText)
                .font(.body)
                .padding(8)
                .background(Color(uiColor: .secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .frame(minHeight: 220)

            Button {
                controller.saveAndCopy()
                // `phase` flips to .done → onChange in body dismisses.
            } label: {
                Label("Copy & close", systemImage: "doc.on.clipboard.fill")
                    .font(.title3.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
            }
            .buttonStyle(.borderedProminent)
            .tint(.speakistPeach)
        }
    }

    private func errorView(message: String) -> some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 60))
                .foregroundStyle(.speakistCoral)
            Text(message)
                .font(.body)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .padding(.horizontal)
            Spacer()
            Button("Close") {
                controller.cancel()
                dismiss()
            }
            .buttonStyle(.borderedProminent)
            .tint(.speakistPeach)
        }
    }
}
