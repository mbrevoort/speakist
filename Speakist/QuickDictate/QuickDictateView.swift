import SwiftUI
import Combine

/// In-window dictation flow surfaced from the main window sidebar.
/// Provides a record → review → copy loop that doesn't depend on the
/// push-to-talk shortcut and doesn't paste at the cursor — handy when
/// the user isn't focused on an editable target, wants to review the
/// transcript before sharing it, or hasn't set up a global shortcut.
///
/// The two-layer split is the standard SwiftUI workaround for the
/// fact that `@StateObject`'s `init` can't read `@EnvironmentObject`.
/// Outer view reads the env; inner view constructs the controller
/// from it exactly once.
struct QuickDictateView: View {
    @EnvironmentObject var env: AppEnvironment

    var body: some View {
        QuickDictatePane(env: env)
    }
}

private struct QuickDictatePane: View {
    @StateObject private var controller: QuickDictateController

    init(env: AppEnvironment) {
        _controller = StateObject(wrappedValue: QuickDictateController(env: env))
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                content
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 28)
            .frame(maxWidth: .infinity)
        }
        // Tear the recording session down if the user navigates
        // away from the Quick Dictate tab mid-recording — otherwise
        // the engine would keep capturing in the background.
        .onDisappear { controller.cancel() }
    }

    @ViewBuilder
    private var content: some View {
        switch controller.phase {
        case .idle:           idleView
        case .preparing:      preparingView
        case .recording:      recordingView
        case .transcribing:   transcribingView
        case .reviewing:      reviewingView
        case .error(let m):   errorView(message: m)
        case .done:           doneView
        }
    }

    // MARK: - Phase views

    private var idleView: some View {
        VStack(spacing: 22) {
            heroIcon
            VStack(spacing: 6) {
                Text("Quick Dictate")
                    .font(.system(size: 22, weight: .semibold))
                Text("Record, review, and copy. The transcript lands on your clipboard so you can paste it anywhere.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 460)
            }
            Button {
                Task { await controller.start() }
            } label: {
                Label("Start recording", systemImage: "mic.fill")
                    .font(.headline)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(.speakistPeach)
            .keyboardShortcut(.return, modifiers: [])
        }
        .padding(.top, 20)
    }

    private var preparingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
            Text("Preparing microphone…")
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 60)
    }

    private var recordingView: some View {
        VStack(spacing: 24) {
            // Voice-driven concentric peach rings. Mirrors the iOS
            // visual so the two platforms feel like the same product.
            ZStack {
                Circle()
                    .fill(Color.speakistPeach.opacity(0.16))
                    .frame(width: 160 + CGFloat(controller.level) * 160,
                           height: 160 + CGFloat(controller.level) * 160)
                    .animation(.spring(response: 0.18, dampingFraction: 0.55), value: controller.level)
                Circle()
                    .fill(Color.speakistPeach.opacity(0.28))
                    .frame(width: 150 + CGFloat(controller.level) * 90,
                           height: 150 + CGFloat(controller.level) * 90)
                    .animation(.spring(response: 0.25, dampingFraction: 0.6), value: controller.level)
                Circle()
                    .fill(Color.speakistPeach)
                    .frame(width: 130, height: 130)
                Image(systemName: "waveform")
                    .font(.system(size: 44, weight: .medium))
                    .foregroundStyle(.white)
                    .symbolEffect(.variableColor.iterative.reversing, options: .repeating)
            }
            .frame(width: 320, height: 320)

            Text("Listening…")
                .font(.title3.weight(.medium))
                .foregroundStyle(.primary)

            HStack(spacing: 12) {
                Button(role: .cancel) {
                    controller.cancel()
                } label: {
                    Label("Cancel", systemImage: "xmark")
                        .padding(.horizontal, 6)
                }
                .controlSize(.large)

                Button {
                    Task { await controller.stop() }
                } label: {
                    Label("Stop & transcribe", systemImage: "stop.fill")
                        .font(.headline)
                        .padding(.horizontal, 8)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(.speakistPeach)
                .keyboardShortcut(.return, modifiers: [])
            }
        }
    }

    private var transcribingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
            Text("Transcribing…")
                .font(.title3)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 60)
    }

    private var reviewingView: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Review and edit")
                .font(.headline)
                .foregroundStyle(.secondary)

            TextEditor(text: $controller.editedText)
                .font(.body)
                .padding(10)
                .background(Color(NSColor.textBackgroundColor))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(Color.secondary.opacity(0.2)))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .frame(minHeight: 220)

            HStack {
                Button(role: .destructive) {
                    controller.cancel()
                } label: {
                    Label("Discard", systemImage: "trash")
                }
                .controlSize(.large)
                Spacer()
                Button {
                    controller.saveAndCopy()
                } label: {
                    Label("Copy", systemImage: "doc.on.clipboard.fill")
                        .font(.headline)
                        .padding(.horizontal, 8)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(.speakistPeach)
                .keyboardShortcut(.return, modifiers: [.command])
            }
        }
        .frame(maxWidth: 640)
    }

    private func errorView(message: String) -> some View {
        VStack(spacing: 18) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 44))
                .foregroundStyle(.speakistCoral)
            Text(message)
                .font(.body)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 460)
            Button("Try again") {
                controller.reset()
                Task { await controller.start() }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(.speakistPeach)
        }
        .padding(.vertical, 40)
    }

    private var doneView: some View {
        VStack(spacing: 18) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(.speakistSage)
            Text("Copied to clipboard")
                .font(.title3.weight(.semibold))
            Text("Saved to History. Paste anywhere with ⌘V.")
                .font(.callout)
                .foregroundStyle(.secondary)
            Button {
                controller.reset()
            } label: {
                Label("Record another", systemImage: "mic.fill")
                    .font(.headline)
                    .padding(.horizontal, 8)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(.speakistPeach)
            .keyboardShortcut(.return, modifiers: [])
        }
        .padding(.vertical, 40)
    }

    private var heroIcon: some View {
        ZStack {
            Circle()
                .fill(Color.speakistPeach.opacity(0.18))
                .frame(width: 150, height: 150)
            Circle()
                .fill(Color.speakistPeach.opacity(0.32))
                .frame(width: 120, height: 120)
            Circle()
                .fill(Color.speakistPeach)
                .frame(width: 96, height: 96)
            Image(systemName: "mic.fill")
                .font(.system(size: 38, weight: .medium))
                .foregroundStyle(.white)
        }
    }
}
