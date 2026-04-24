import SwiftUI

/// Full-screen card shown while a Speak Session is active. Two jobs:
///
///   1. Tell the user what's happening — "Listening / iPhone Microphone",
///      matching iOS's own mental model of microphone ownership.
///   2. Teach the swipe-right-to-return gesture, which iOS 26.4 made
///      mandatory (the old auto-return trick was closed off by Apple).
///
/// After the user has successfully completed the swipe-to-return gesture
/// a few times, we stop showing the teaching line — this becomes muscle
/// memory and the overlay can be minimized. For now we always show it.
/// Subtitle under the overlay's main heading. Reflects whichever phase
/// of the session we're in so the user can tell at a glance whether
/// they're still armed, actively recording, or transcribing.
private func listenStatusDetail(_ status: SpeakSessionStatus) -> String {
    switch status {
    case .idle:         return "iPhone Microphone"
    case .activating:   return "Go back to your app"
    case .listening:    return "Listening…"
    case .transcribing: return "Transcribing…"
    case .done:         return "Done"
    case .error:        return "Something went wrong"
    }
}

struct ListeningOverlay: View {
    @EnvironmentObject private var session: SpeakSessionController

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.speakistPlum
                .ignoresSafeArea()
                .opacity(0.97)

            // Close X — cancels the session and returns the user to
            // the main home view. Useful when the user opened
            // Speakist by accident or changes their mind about
            // dictating: without this they'd have to wait for the
            // 5-min session expiry or swipe away and come back.
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                session.cancelSession()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(
                        Circle().fill(.white.opacity(0.18))
                    )
            }
            .padding(.top, 12)
            .padding(.trailing, 16)
            .accessibilityLabel("Cancel Speakist session")
            .zIndex(2)

            VStack(spacing: 28) {
                Spacer()

                Image(systemName: "waveform")
                    .font(.system(size: 72, weight: .light))
                    .foregroundStyle(.white.opacity(0.95))
                    .symbolEffect(.variableColor.iterative.reversing, options: .repeating)

                VStack(spacing: 8) {
                    Text("Ready to listen")
                        .font(.system(size: 28, weight: .semibold, design: .serif))
                        .foregroundStyle(.white)
                    Text(listenStatusDetail(session.status))
                        .font(.system(size: 16))
                        .foregroundStyle(.white.opacity(0.7))
                }

                Spacer()

                VStack(spacing: 12) {
                    Text("Swipe right along the bottom to return")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.white.opacity(0.9))
                        .multilineTextAlignment(.center)

                    Text("Tap **Begin Speaking** on the Speakist keyboard to start, then the **✓** when you're done. We won't record until you ask.")
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.55))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }

                // Animated gesture hint pinned near the bottom of the
                // screen so the illustrated pill visually aligns with
                // where the real iOS home indicator actually is.
                // Users' eyes learn to associate "that bar at the
                // bottom" with the swipe-back gesture; putting our
                // didactic pill in the same place makes the muscle-
                // memory transfer land.
                SwipeBackHint()
                    .frame(height: 130)
                    .padding(.bottom, 2)
            }
        }
    }
}
