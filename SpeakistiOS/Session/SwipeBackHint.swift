import SwiftUI

/// Animated gesture demo for the iOS edge-swipe-right "return to
/// previous app" gesture. The user has to perform this every time
/// they go through Speakist; iOS 26.4 closed the auto-return loophole
/// and there is no programmatic alternative. So this overlay has to
/// teach the gesture as clearly as we can.
///
/// Layout — three persistent layers + one animated finger:
///
///   * Home-indicator pill — sits at the bottom of the frame where
///     iOS's real home indicator lives. The user's eye learns to
///     associate "that bar at the bottom" with "the swipe-back
///     surface" — putting our didactic pill in the same place
///     transfers cleanly to the real thing.
///   * Dashed trail — runs the full length of the swipe path so the
///     user sees where to drag their finger, even before the
///     animation arrives at any given frame. Without this people
///     watch the finger animate, then have to guess the end point
///     once it disappears.
///   * Start target — a pulsing ring at the left end of the trail
///     that's visible the entire time, including during rest
///     periods. Tells the user where to put their finger BEFORE the
///     animated finger appears.
///   * Animated finger — pulses in at the start, holds for a beat,
///     then traces the full trail at a deliberate pace.
///
/// Driven by `TimelineView(.animation)` with a phase-based
/// computation instead of `withAnimation` chains — gives us precise
/// control over where in the cycle each beat lands and plays cleanly
/// in a modal context.
struct SwipeBackHint: View {
    /// 4.0s cycle. Slowed from the previous 2.6s because users said
    /// the swipe was hard to mimic; giving the eye more time on the
    /// "tap, hold, drag" beats made the gesture land first try.
    private let cycleDuration: Double = 4.0

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let phase = (t.truncatingRemainder(dividingBy: cycleDuration)) / cycleDuration

            GeometryReader { geo in
                // ~134pt-wide centered pill closely matches the real
                // iOS home indicator. Capped so it doesn't blow up
                // on iPad / landscape; floored so it stays
                // recognizable on the smallest iPhone.
                let trackWidth = min(max(geo.size.width - 80, 200), 240)
                let startX = (geo.size.width - trackWidth) / 2
                let endX = startX + trackWidth
                // Pill sits flush with the bottom of the hint frame so
                // it lines up with where iOS draws the real home
                // indicator. (Parent view positions the frame near
                // the screen's bottom safe-area edge.)
                let pillY = geo.size.height - 4
                // Finger center sits slightly above the pill so the
                // index fingertip — after the -45° rotation — lands
                // ON the pill, not below it.
                let fingerY = pillY - 2

                ZStack {
                    // === Persistent layer: dashed trail =============
                    // Faint dashed line along the full swipe path.
                    // Visible at all times so the user can pre-plan
                    // their drag before the animated finger fires.
                    Path { p in
                        p.move(to: CGPoint(x: startX, y: pillY))
                        p.addLine(to: CGPoint(x: endX, y: pillY))
                    }
                    .stroke(.white.opacity(0.28),
                            style: StrokeStyle(lineWidth: 1.5,
                                               lineCap: .round,
                                               dash: [3, 4]))

                    // === Persistent layer: home-indicator pill ======
                    // Solid pill segment so the user sees the same
                    // bar shape iOS will draw at the bottom of the
                    // host app after they swipe over.
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(.white.opacity(0.45))
                        .frame(width: trackWidth, height: 6)
                        .position(x: geo.size.width / 2, y: pillY)

                    // === Persistent layer: pulsing start target =====
                    // Soft ring centered on the start point that
                    // breathes 1.0 → 1.25 scale forever. Anchors the
                    // user's eye to the touch-down spot so they're
                    // not guessing where to start when the animation
                    // is between cycles.
                    let breath = 1.0 + 0.18 * sin(phase * 2 * .pi)
                    Circle()
                        .stroke(.white.opacity(0.55), lineWidth: 1.6)
                        .frame(width: 26, height: 26)
                        .scaleEffect(breath)
                        .position(x: startX, y: pillY)

                    // === Persistent layer: end target ===============
                    // Lightweight arrow + dot at the end so the user
                    // sees where the swipe should release. Lower
                    // opacity than the start target so the eye still
                    // leads with "tap here".
                    Circle()
                        .fill(.white.opacity(0.35))
                        .frame(width: 8, height: 8)
                        .position(x: endX, y: pillY)

                    let appearance = appearance(for: phase)

                    // === Animated layer: travel ripple =============
                    // Widening circle at the touch-down point that
                    // fades as the swipe begins, reinforcing where
                    // the gesture starts.
                    Circle()
                        .stroke(.white.opacity(appearance.rippleOpacity), lineWidth: 2)
                        .frame(width: 38 + 38 * appearance.progress,
                               height: 38 + 38 * appearance.progress)
                        .position(x: startX, y: pillY)

                    // === Animated layer: brightening trail =========
                    // As the finger slides, paint a brighter solid
                    // segment from start to current position. Gives
                    // the user a "filling progress bar" cue for how
                    // far the drag has gone.
                    Path { p in
                        p.move(to: CGPoint(x: startX, y: pillY))
                        p.addLine(to: CGPoint(x: startX + trackWidth * appearance.progress, y: pillY))
                    }
                    .stroke(.white.opacity(0.7 * appearance.opacity),
                            style: StrokeStyle(lineWidth: 3, lineCap: .round))

                    // === Animated layer: finger ====================
                    // Rotated -45° so the fingertip points back along
                    // the travel direction — the natural pose for a
                    // right-going drag.
                    let x = startX + trackWidth * appearance.progress
                    Image(systemName: "hand.point.up.left.fill")
                        .font(.system(size: 46, weight: .medium))
                        .foregroundStyle(.white)
                        .rotationEffect(.degrees(-45))
                        .scaleEffect(appearance.scale)
                        .opacity(appearance.opacity)
                        .shadow(color: .black.opacity(0.25), radius: 4, y: 1)
                        .position(x: x, y: fingerY)
                }
            }
        }
    }

    /// Given a normalized `phase` (0…1 over the full cycle), return
    /// how to render the finger: opacity, scale (for the tap pulse),
    /// progress along the track, and ripple fade.
    private func appearance(for phase: Double) -> FingerAppearance {
        // Phase segments as fractions of cycleDuration. Stretched vs.
        // the previous tighter values: the hold and slide phases got
        // most of the extra time so the gesture is easier to mimic.
        let fadeIn = 0.06     // ~240ms — finger drops in
        let tapHold = 0.15    // ~600ms — settle on the start point
        let slide = 0.50      // ~2000ms — slow trace across the bar
        let endHold = 0.07    // ~280ms — pause at end before lifting
        let fadeOut = 0.07    // ~280ms — finger lifts away
        let rest = 1.0 - (fadeIn + tapHold + slide + endHold + fadeOut)  // ~600ms

        var progress: Double = 0
        var scale: Double = 1.0
        var opacity: Double = 0
        var rippleOpacity: Double = 0

        if phase < fadeIn {
            // Finger fades in at the start, descending onto the bar.
            let p = phase / fadeIn
            opacity = p
            scale = 1.0 + 0.30 * (1 - p)
        } else if phase < fadeIn + tapHold {
            // Tap-and-hold. Quick bloom + ripple at touch-down, then
            // settles. The hold gives the user time to register
            // "this is where my finger goes" before the slide starts.
            let p = (phase - fadeIn) / tapHold
            opacity = 1.0
            scale = 1.0 + 0.18 * sin(p * .pi)
            rippleOpacity = 0.6 * (1 - p)
        } else if phase < fadeIn + tapHold + slide {
            // Slow slide. Easing keeps it from feeling robotic; the
            // long duration lets the user trace along with their eye.
            let p = (phase - fadeIn - tapHold) / slide
            opacity = 1.0
            progress = ease(p)
        } else if phase < fadeIn + tapHold + slide + endHold {
            // Hold at end before lifting — emphasizes the destination
            // so the user understands "drag THIS far, then let go".
            opacity = 1.0
            progress = 1.0
        } else if phase < fadeIn + tapHold + slide + endHold + fadeOut {
            // Fade-out at the end of the track.
            let p = (phase - fadeIn - tapHold - slide - endHold) / fadeOut
            opacity = 1.0 - p
            progress = 1.0
        } else {
            // Rest — finger is gone; persistent layers (pulsing start
            // target, dashed trail, pill) carry the visual on their
            // own so the user always sees the touch target.
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
            .frame(height: 130)
            .padding()
    }
}
