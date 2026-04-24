import SwiftUI

/// Animated gesture demo: a finger pointer taps the simulated home
/// bar, slides right along it, and fades away. Loops with a short
/// pause. Shown on the ListeningOverlay so users who haven't learned
/// the iOS edge-swipe gesture have a concrete thing to mimic.
///
/// Driven by `TimelineView(.animation)` with a phase-based computation
/// instead of `withAnimation` chains — gives us precise control over
/// where in the cycle the fade-in, tap pulse, slide, and fade-out
/// each happen, and plays cleanly in a modal context without the
/// interruption quirks `repeatForever` sometimes has.
struct SwipeBackHint: View {
    /// Full cycle length: 0.25s fade-in/tap, 0.2s pause, 1.1s slide,
    /// 0.25s fade-out, 0.8s rest. Long enough that the user has time
    /// to register what's happening; short enough that it repeats
    /// before attention wanders.
    private let cycleDuration: Double = 2.6

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let phase = (t.truncatingRemainder(dividingBy: cycleDuration)) / cycleDuration

            GeometryReader { geo in
                // Track width bumped ~20% (190 → 228pt cap) but
                // re-centered horizontally. The finger enters and
                // exits along this centered track, matching the real
                // iOS home indicator which is also centered.
                let trackWidth = min(geo.size.width - 50, 228)
                let startX = (geo.size.width - trackWidth) / 2
                // Pill sits 4pt from the bottom of the frame so the
                // illustration pill sits where the real iOS home
                // indicator would be on-screen. With the hint frame
                // pushed close to the bottom edge of the screen
                // (small trailing padding in the parent), these two
                // bars line up in the user's eye.
                let pillY = geo.size.height - 4
                // The finger icon is rotated -45° with the unrotated
                // fingertip at the upper-left. After rotation the
                // fingertip ends up at the left-middle of the rotated
                // bounds, roughly at the icon's center-y. Aligning
                // the icon's center vertically with the pill puts the
                // fingertip right on the pill surface, which is what
                // "touching and dragging" looks like.
                let fingerY = pillY - 2

                ZStack {
                    // Simulated home-indicator pill — horizontally
                    // centered to match the real home bar.
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(.white.opacity(0.3))
                        .frame(width: trackWidth, height: 6)
                        .position(x: geo.size.width / 2, y: pillY)

                    let appearance = appearance(for: phase)

                    // Trailing ripple — a widening circle at the
                    // touch-down point, fading as the swipe proceeds.
                    Circle()
                        .stroke(.white.opacity(appearance.rippleOpacity), lineWidth: 2)
                        .frame(width: 44 + 44 * appearance.progress,
                               height: 44 + 44 * appearance.progress)
                        .position(x: startX, y: pillY)

                    // Phase-driven finger. Rotated -45° so the index
                    // finger tip points west — natural trailing
                    // orientation for a right-going drag: the hand
                    // leads the motion, the finger tip points back
                    // along the travel path.
                    let x = startX + trackWidth * appearance.progress
                    Image(systemName: "hand.point.up.left.fill")
                        .font(.system(size: 42, weight: .medium))
                        .foregroundStyle(.white)
                        .rotationEffect(.degrees(-45))
                        .scaleEffect(appearance.scale)
                        .opacity(appearance.opacity)
                        .position(x: x, y: fingerY)
                }
            }
        }
    }

    /// Given a normalized `phase` (0…1 over the full cycle), return
    /// how to render the finger: opacity, scale (for the tap pulse),
    /// progress along the track, and ripple fade.
    private func appearance(for phase: Double) -> FingerAppearance {
        // Split the cycle into segments. All boundaries expressed as
        // fractions of the full cycle duration so edits to individual
        // segment durations don't drift.
        let fadeIn = 0.06
        let tapPulse = 0.10
        let slide = 0.55
        let fadeOut = 0.10
        let rest = 1.0 - (fadeIn + tapPulse + slide + fadeOut)   // 0.19

        var progress: Double = 0
        var scale: Double = 1.0
        var opacity: Double = 0
        var rippleOpacity: Double = 0

        if phase < fadeIn {
            // Finger fades in at the start of the track.
            let p = phase / fadeIn
            opacity = p
            scale = 1.0 + 0.25 * (1 - p)   // arrives "descending" onto the bar
        } else if phase < fadeIn + tapPulse {
            // Tap pulse — quick scale bloom + ripple at touch-down.
            let p = (phase - fadeIn) / tapPulse
            opacity = 1.0
            scale = 1.0 + 0.15 * sin(p * .pi)
            rippleOpacity = 0.55 * (1 - p)
        } else if phase < fadeIn + tapPulse + slide {
            // Slide phase — finger moves along the bar; ripple
            // continues to dissipate behind it.
            let p = (phase - fadeIn - tapPulse) / slide
            opacity = 1.0
            progress = ease(p)
            rippleOpacity = 0
        } else if phase < fadeIn + tapPulse + slide + fadeOut {
            // Fade-out at the end of the track.
            let p = (phase - fadeIn - tapPulse - slide) / fadeOut
            opacity = 1.0 - p
            progress = 1.0
        } else {
            // Rest — finger is gone, track is empty.
            _ = rest
            opacity = 0
            progress = 0
        }

        return FingerAppearance(progress: progress, scale: scale,
                                opacity: opacity, rippleOpacity: rippleOpacity)
    }

    /// Smooth ease-in-out — quadratic acceleration and deceleration
    /// so the slide doesn't feel mechanical.
    private func ease(_ x: Double) -> Double {
        x < 0.5
            ? 2 * x * x
            : 1 - pow(-2 * x + 2, 2) / 2
    }

    private struct FingerAppearance {
        let progress: Double     // 0…1 along the track
        let scale: Double        // for tap pulse
        let opacity: Double      // finger alpha
        let rippleOpacity: Double // touch-down ripple alpha
    }
}

#Preview {
    ZStack {
        Color.speakistPlum.ignoresSafeArea()
        SwipeBackHint()
            .frame(height: 100)
            .padding()
    }
}
