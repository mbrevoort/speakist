import UIKit

/// Five peach bars that track the user's voice in real time. Level
/// comes from the main app's `AudioRecorder` RMS callback, published
/// to the App Group so the keyboard extension (which has no mic
/// access) can read it and render amplitude-driven bars. A small
/// idle-pulse keeps the bars alive during silence so the UI never
/// looks frozen, and per-bar sine offsets produce a natural asymmetric
/// shape rather than five identical bouncing columns.
///
/// `setLevel(_:)` is called by the controller each time a fresh level
/// arrives. The internal `CADisplayLink` handles smoothing + the idle
/// pulse.
final class WaveformView: UIView {

    private let barCount = 5
    private let minHeightRatio: CGFloat = 0.16
    private let maxHeightRatio: CGFloat = 0.95
    private let barWidth: CGFloat = 4.5
    private let barSpacing: CGFloat = 6

    private var displayLink: CADisplayLink?
    /// Per-bar sine phase offset. Combined with a slow clock tick
    /// these phases give each bar its own natural-feeling rhythm.
    private lazy var phases: [CGFloat] = (0..<barCount).map { _ in CGFloat.random(in: 0...(2 * .pi)) }
    /// Per-bar offset weights — outer bars get dampened relative to
    /// the center so the silhouette peaks in the middle like a speech
    /// envelope rather than a flat block.
    private let perBarWeights: [CGFloat] = [0.55, 0.82, 1.0, 0.82, 0.55]

    /// Latest published level (0…1). Written from the main queue by
    /// `setLevel(_:)`, read each display-link tick.
    private var currentLevel: CGFloat = 0
    /// Smoothed level used for drawing — low-pass-filtered so frame-
    /// to-frame jitter doesn't look like visual noise.
    private var smoothedLevel: CGFloat = 0
    /// Per-bar heights actually drawn each frame.
    private var heights: [CGFloat] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        heights = Array(repeating: minHeightRatio, count: barCount)
    }

    required init?(coder: NSCoder) { fatalError() }

    /// Update the input level (0…1). Safe to call at any rate — the
    /// display link smooths whatever arrives. If levels stop flowing
    /// the smoothed value naturally decays toward the idle baseline.
    func setLevel(_ level: Float) {
        let raw = max(0, min(1, CGFloat(level)))
        // Boost raw level — `AudioRecorder` emits already-sqrt-curved
        // RMS that lives in the 0.1–0.4 range for normal speech. A
        // 2.2× gain lets normal voice fill most of the available bar
        // height without clipping on loud input (`min(1, ...)`).
        currentLevel = min(1, raw * 2.2)
    }

    func startAnimating() {
        guard displayLink == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 20, maximum: 60, preferred: 30)
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    func stopAnimating() {
        displayLink?.invalidate()
        displayLink = nil
        // Reset for next start so the first frame isn't a jump from
        // whatever the last session left in memory.
        currentLevel = 0
        smoothedLevel = 0
        heights = Array(repeating: minHeightRatio, count: barCount)
        setNeedsDisplay()
    }

    override func willMove(toWindow newWindow: UIWindow?) {
        super.willMove(toWindow: newWindow)
        if newWindow == nil { stopAnimating() }
    }

    @objc private func tick(_ link: CADisplayLink) {
        // Asymmetric attack/release so bars jump up fast when the
        // user starts speaking but decay a bit more gracefully — same
        // envelope pattern a VU meter uses, gives the waveform its
        // "reactive" feel instead of a lazy low-pass.
        let attackWeight: CGFloat = 0.75    // 75% weight on new value going up
        let releaseWeight: CGFloat = 0.45   // 45% weight on new value going down
        let weight = currentLevel > smoothedLevel ? attackWeight : releaseWeight
        smoothedLevel = smoothedLevel * (1 - weight) + currentLevel * weight

        let t = CGFloat(link.timestamp)
        // Idle pulse only when the mic is genuinely quiet — while the
        // user is speaking we cut the idle to near-zero so the real
        // level is what drives the bars, not the baseline breath.
        let idle: CGFloat
        if smoothedLevel < 0.04 {
            idle = 0.10 + 0.04 * (sin(t * 2.1) + 1) * 0.5
        } else {
            idle = 0.04
        }

        for i in 0..<barCount {
            // Per-bar sine offset adds the asymmetric "wobble" that
            // makes real speech look like speech — bumped to 0.18 so
            // the shimmer across bars is more visible on real voice.
            let sineOffset = sin(t * 5.2 + phases[i]) * 0.18
            let target = idle + (smoothedLevel + sineOffset) * perBarWeights[i] * (maxHeightRatio - minHeightRatio)
            let clampedTarget = max(minHeightRatio, min(maxHeightRatio, target))
            // Per-bar smoothing tightened too — 30/70 so bars track
            // the incoming envelope snappily instead of floating.
            heights[i] = heights[i] * 0.30 + clampedTarget * 0.70
        }
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        let totalWidth = CGFloat(barCount) * barWidth + CGFloat(barCount - 1) * barSpacing
        var x = (rect.width - totalWidth) / 2
        let centerY = rect.height / 2
        UIColor.speakistPeach.setFill()
        for i in 0..<barCount {
            let h = max(minHeightRatio, min(maxHeightRatio, heights[i])) * rect.height
            let barRect = CGRect(x: x, y: centerY - h / 2, width: barWidth, height: h)
            UIBezierPath(roundedRect: barRect, cornerRadius: barWidth / 2).fill()
            x += barWidth + barSpacing
        }
    }
}
