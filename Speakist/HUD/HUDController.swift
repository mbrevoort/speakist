import Foundation
import AppKit
import ApplicationServices
import SwiftUI
import Combine

enum HUDState: Equatable {
    /// Shown the instant the shortcut goes down — before the audio
    /// engine has actually warmed up. Acts as a "ready" affordance so
    /// the user gets immediate visual feedback even if the recorder
    /// takes a few ms to come online.
    case preparing
    /// Mic is live, capturing samples. Waveform animates, timer ticks.
    case recording
    /// User released the shortcut. Recorder stopped, audio is being
    /// uploaded + transcribed. Waveform replaced with an animated
    /// "Transcribing…" indicator; timer is frozen.
    case transcribing
    case hidden
}

@MainActor
final class HUDController: ObservableObject {
    @Published var state: HUDState = .hidden
    @Published var elapsed: TimeInterval = 0
    /// 12-sample ring of recent RMS levels (0...1) — kept around for
    /// any future need (e.g., a history graph in the dashboard) but
    /// no longer drives the HUD waveform directly.
    @Published var levels: [Float] = Array(repeating: 0, count: 12)
    /// Per-band smoothed magnitudes for the HUD's frequency-band
    /// visualization. Index 0 = lowest band (≈80 Hz), last = highest
    /// (≈4 kHz). Each value is independently smoothed with an
    /// asymmetric attack/release envelope so bars feel reactive on
    /// onsets but don't flicker during sustained vowels.
    @Published var bandLevels: [Double] = Array(repeating: 0, count: AudioRecorder.bandCount)

    private let preferences: Preferences
    private var panel: HUDPanel?
    private var levelSubscription: AnyCancellable?
    private var bandSubscription: AnyCancellable?
    private var timer: Timer?
    private var startTime: Date?

    init(preferences: Preferences) {
        self.preferences = preferences
    }

    func bind(to recorder: AudioRecorder) {
        levelSubscription = recorder.levels
            .receive(on: RunLoop.main)
            .sink { [weak self] level in
                self?.push(level: level)
            }
        bandSubscription = recorder.bandLevels
            .receive(on: RunLoop.main)
            .sink { [weak self] bands in
                self?.push(bands: bands)
            }
    }

    /// Show the HUD instantly, before the recorder has started. Called
    /// the moment the push-to-talk shortcut goes down so the user gets
    /// a UI response inside the same frame as their key press —
    /// engine startup latency is hidden behind the "preparing" state.
    func showPreparing() {
        guard preferences.showHUD else { return }
        if panel == nil {
            panel = HUDPanel(contentView: HUDView(controller: self))
        }
        state = .preparing
        elapsed = 0
        startTime = nil
        levels = Array(repeating: 0, count: 12)
        bandLevels = Array(repeating: 0, count: AudioRecorder.bandCount)
        panel?.presentAnchoredToFocusedField()
    }

    /// Flip from `.preparing` to `.recording` once the audio engine is
    /// running and producing samples. Starts the timer here, not in
    /// `showPreparing`, so the elapsed clock reflects real recording
    /// time — not engine-warmup time.
    func activateRecording() {
        guard preferences.showHUD else { return }
        if panel == nil {
            // Defensive: someone called activate without preparing.
            panel = HUDPanel(contentView: HUDView(controller: self))
            panel?.presentAnchoredToFocusedField()
        }
        state = .recording
        elapsed = 0
        startTime = Date()
        levels = Array(repeating: 0, count: 12)
        bandLevels = Array(repeating: 0, count: AudioRecorder.bandCount)
        startTimer()
    }

    /// Stop the timer and swap the waveform out for the transcribing
    /// indicator. Called the instant the shortcut is released so the
    /// user sees the state change immediately, well before the
    /// transcription request actually returns.
    func setTranscribing() {
        state = .transcribing
        timer?.invalidate()
        timer = nil
    }

    func hide() {
        state = .hidden
        timer?.invalidate()
        timer = nil
        panel?.dismiss { [weak self] in
            self?.panel = nil
        }
    }

    // MARK: - Internal

    /// Display gain applied on top of the analyzer's already-
    /// normalized band magnitudes. The analyzer normalizes peaks to
    /// roughly [0.6, 0.8] for typical voice; this gain plus the
    /// asymmetric smoother below pushes those peaks all the way to
    /// the bar's top edge.
    private let displayGain: Double = 1.4
    /// Attack weight — bars chase rising input fast (85% toward
    /// the new peak per frame) so the visualization reads as
    /// reactive on onsets.
    private let attackWeight: Double = 0.85
    /// Release weight — gentler fall so bars don't snap to zero at
    /// the end of every syllable.
    private let releaseWeight: Double = 0.30

    private func push(level: Float) {
        levels.removeFirst()
        levels.append(level)
    }

    /// Apply the same VU-style attack/release envelope to each
    /// band's magnitude independently — so a strong fundamental
    /// can ride high while sibilants drop out, and vice versa.
    private func push(bands: [Float]) {
        guard bands.count == bandLevels.count else { return }
        var updated = bandLevels
        for i in 0..<bands.count {
            let target = min(1.0, Double(bands[i]) * displayGain)
            let weight = target > updated[i] ? attackWeight : releaseWeight
            updated[i] = updated[i] * (1 - weight) + target * weight
        }
        bandLevels = updated
    }

    private func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let start = self.startTime else { return }
                self.elapsed = Date().timeIntervalSince(start)
            }
        }
    }
}

/// Borderless, non-activating panel positioned near the focused text
/// field if Accessibility lets us read its bounds; falls back to the
/// mouse cursor otherwise.
final class HUDPanel: NSPanel {
    /// Compact panel size. Was 360×72 when the layout had a brand
    /// icon + waveform strip + timer; now that the icon is gone and
    /// the waveform shares the activity slot with the transcribing
    /// dots, the panel collapses to a much smaller footprint.
    static let panelSize = NSSize(width: 200, height: 64)

    init<Content: View>(contentView: Content) {
        super.init(contentRect: NSRect(origin: .zero, size: HUDPanel.panelSize),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered,
                   defer: false)
        self.isFloatingPanel = true
        self.level = .statusBar
        self.isOpaque = false
        self.backgroundColor = .clear
        self.hasShadow = true
        self.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        self.hidesOnDeactivate = false
        self.animationBehavior = .utilityWindow
        self.ignoresMouseEvents = true

        let hosting = NSHostingView(rootView: contentView)
        hosting.frame = NSRect(origin: .zero, size: HUDPanel.panelSize)
        self.contentView = hosting
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// Anchor the HUD near the user's text caret if the Accessibility
    /// API can resolve it. Three-tier fallback so we always pick the
    /// most precise anchor available:
    ///
    ///   1. **Caret rect** — `kAXBoundsForRangeParameterizedAttribute`
    ///      on the focused element's selected text range. This gives
    ///      the actual cursor position, not the field bounds, so the
    ///      HUD hugs the typing point even in a tall text editor.
    ///   2. **Focused field rect** — whole-field bounds. Used when the
    ///      app doesn't support the parameterized bounds query
    ///      (Electron apps in particular, sometimes Slack/Notion).
    ///   3. **Mouse cursor** — last resort if AX is denied or no
    ///      element is focused.
    ///
    /// Either way, we place the HUD just below the anchor with a small
    /// gap (so it doesn't overlap the text being typed), flip above
    /// when there isn't room below, and clamp to the visible screen.
    func presentAnchoredToFocusedField() {
        let anchor = HUDPanel.focusedCaretRect()
            ?? HUDPanel.focusedFieldRect()
            ?? mouseAnchorRect()
        let screen = NSScreen.screens.first(where: {
            NSMouseInRect(NSPoint(x: anchor.midX, y: anchor.midY), $0.frame, false)
        }) ?? NSScreen.main
        guard let frame = screen?.visibleFrame else { return }

        let w = self.frame.width
        let h = self.frame.height

        // Center the HUD horizontally on the focused field. Place it
        // just below the field with a small gap so it doesn't cover
        // what the user is editing. If there isn't room below, flip
        // above the field.
        let gap: CGFloat = 12
        var x = anchor.midX - w / 2
        var y = anchor.minY - h - gap        // below the field (AppKit y-up)
        if y < frame.minY + 8 {
            y = anchor.maxY + gap            // not enough room → above
        }
        x = max(frame.minX + 8, min(x, frame.maxX - w - 8))
        y = max(frame.minY + 8, min(y, frame.maxY - h - 8))

        self.setFrameOrigin(NSPoint(x: x, y: y))
        self.alphaValue = 0
        self.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.10
            self.animator().alphaValue = 1
        }
    }

    /// Build a synthetic "anchor rect" centered on the mouse cursor,
    /// used when AX can't tell us where the focused field is. Sized
    /// to a typical text-field height so the same below/above-flip
    /// logic in `presentAnchoredToFocusedField` works either way.
    private func mouseAnchorRect() -> NSRect {
        let p = NSEvent.mouseLocation
        return NSRect(x: p.x - 1, y: p.y - 12, width: 2, height: 24)
    }

    func dismiss(completion: @escaping () -> Void) {
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.18
            self.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            self?.orderOut(nil)
            completion()
        })
    }

    // MARK: - Focused-field bounds via Accessibility

    /// Resolve the system-focused element to an `AXUIElement`, or nil
    /// if AX is denied / no element is focused. Centralized so the
    /// caret-rect and field-rect helpers don't duplicate the lookup.
    private static func focusedAXElement() -> AXUIElement? {
        guard AXIsProcessTrusted() else { return nil }
        let systemWide = AXUIElementCreateSystemWide()
        var focusedRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            systemWide, kAXFocusedUIElementAttribute as CFString, &focusedRef
        ) == .success, let focused = focusedRef else { return nil }
        return (focused as! AXUIElement)
    }

    /// Convert an AX-flipped rect (origin top-left of primary screen)
    /// to AppKit bottom-left screen coords. Returns nil if no screen
    /// is available (impossible in practice but the unwrap is cheap).
    private static func appKitRect(fromAXRect ax: CGRect) -> NSRect? {
        guard let primary = NSScreen.screens.first else { return nil }
        let primaryHeight = primary.frame.height
        let flippedY = primaryHeight - ax.origin.y - ax.height
        return NSRect(x: ax.origin.x, y: flippedY, width: ax.width, height: ax.height)
    }

    /// Read the on-screen rect of the user's text caret via
    /// `kAXBoundsForRangeParameterizedAttribute` on the focused
    /// element's selected text range. Most native AppKit text views
    /// support this; many Electron apps don't (caller falls back to
    /// `focusedFieldRect`).
    static func focusedCaretRect() -> NSRect? {
        guard let element = focusedAXElement() else { return nil }

        // Selected text range is a CFRange — for a caret it's
        // length=0, for a selection it's the highlighted span.
        var rangeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element, kAXSelectedTextRangeAttribute as CFString, &rangeRef
        ) == .success, let rangeValue = rangeRef else { return nil }
        var range = CFRange()
        AXValueGetValue(rangeValue as! AXValue, .cfRange, &range)

        // Some apps (TextEdit, Xcode source editor) return an empty
        // rect for length=0 queries. Pad to length=1 so we always
        // hit a real glyph rect — clamping back into the field if
        // the caret sits at the very end of the document.
        var queryRange = CFRange(
            location: range.location > 0 ? range.location - 1 : 0,
            length: 1
        )
        guard let axRange = AXValueCreate(.cfRange, &queryRange) else { return nil }

        var boundsRef: CFTypeRef?
        let status = AXUIElementCopyParameterizedAttributeValue(
            element,
            kAXBoundsForRangeParameterizedAttribute as CFString,
            axRange,
            &boundsRef
        )
        guard status == .success, let bounds = boundsRef else { return nil }
        var rect = CGRect.zero
        AXValueGetValue(bounds as! AXValue, .cgRect, &rect)
        if rect.width <= 0 || rect.height <= 0 { return nil }
        return appKitRect(fromAXRect: rect)
    }

    /// Read the system-wide focused UI element's on-screen rect via
    /// the Accessibility API and convert it to AppKit's bottom-left
    /// coordinate space. Returns nil when AX is denied, no element is
    /// focused, or the focused element doesn't expose position+size
    /// (rare for text fields, common for some Electron apps).
    static func focusedFieldRect() -> NSRect? {
        guard let element = focusedAXElement() else { return nil }

        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success else {
            return nil
        }

        var origin = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(posRef as! AXValue, .cgPoint, &origin)
        AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
        if size.width <= 0 || size.height <= 0 { return nil }

        return appKitRect(fromAXRect: CGRect(origin: origin, size: size))
    }
}

// MARK: - HUD view

private struct HUDView: View {
    @ObservedObject var controller: HUDController

    var body: some View {
        HStack(spacing: 14) {
            activity
                .frame(maxWidth: .infinity)
                .frame(height: 36)
            timeLabel
                .frame(width: 56, alignment: .trailing)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.ultraThinMaterial)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.black.opacity(0.08), lineWidth: 0.5)
        )
        .padding(4)
    }

    /// Single content slot — the waveform during recording, the
    /// transcribing wave-dots after the user releases the shortcut.
    /// The brand icon and the leading-edge column it used to live in
    /// are gone; the recording state is just bars and the elapsed
    /// time, nothing else.
    @ViewBuilder private var activity: some View {
        switch controller.state {
        case .preparing:
            // Empty bars at rest height so the panel doesn't reflow
            // on the first level update. Conveys "ready, not yet
            // capturing" without text.
            VoiceLevelBars(
                bands: Array(repeating: 0, count: AudioRecorder.bandCount),
                isActive: false
            )
        case .recording:
            VoiceLevelBars(bands: controller.bandLevels, isActive: true)
        case .transcribing:
            TranscribingIndicator()
        case .hidden:
            EmptyView()
        }
    }

    @ViewBuilder private var timeLabel: some View {
        switch controller.state {
        case .preparing:
            // "0:00" placeholder so the digit column doesn't shift
            // width on the first tick.
            Text("0:00")
                .font(.system(size: 16, weight: .semibold, design: .monospaced))
                .foregroundStyle(.secondary)
        case .recording, .transcribing:
            // Frozen on `.transcribing` (timer invalidated in
            // `setTranscribing`) but kept at full primary contrast
            // so the user can still read how long they spoke.
            Text(formatTime(controller.elapsed))
                .font(.system(size: 16, weight: .semibold, design: .monospaced))
                .foregroundStyle(.primary)
        case .hidden:
            EmptyView()
        }
    }

    private func formatTime(_ t: TimeInterval) -> String {
        let total = Int(t)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

// The Speakist brand mark + bubble shape + bars inside the bubble
// that previously occupied the HUD's leading slot are gone — the HUD
// is now just the level bars + timer. Brand mark lives in the menu
// bar icon, the dashboard, and onboarding; we don't need it competing
// with the live waveform during a quick dictation.

/// Five peach dots bobbing up and down with phase offsets, producing
/// a left-to-right traveling wave that feels alive without competing
/// with the recording waveform's reactive shape. Purely decorative —
/// signals "we're working on it" without taking up the room a
/// "Transcribing…" label would.
///
/// TimelineView drives the animation on a real clock so it stays
/// smooth even during a long network round-trip.
private struct TranscribingIndicator: View {
    /// Number of dots in the wave. Five reads as a "wave" without
    /// crowding the 250-ish-pt content slot.
    private let dotCount = 5
    /// How tall the wave peaks above/below center. Tuned so the wave
    /// stays inside the 32pt content height.
    private let bounceAmplitude: CGFloat = 6
    /// How fast the wave travels (cycles per second).
    private let waveSpeed: Double = 1.5
    /// Phase offset between adjacent dots — controls the wavelength.
    /// 0.32 means each dot is ~1/3 cycle behind its left neighbor,
    /// giving the impression of one full wave across the row.
    private let dotPhase: Double = 0.32

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 7) {
                Spacer(minLength: 0)
                ForEach(0..<dotCount, id: \.self) { i in
                    let phase = t * waveSpeed - Double(i) * dotPhase
                    let bounce = sin(phase * 2 * .pi)
                    Circle()
                        .fill(Color.speakistPeach)
                        // Up-only displacement so the wave has a
                        // resting baseline; sin(...) goes -1…1, we
                        // map to 0…1 then up.
                        .offset(y: -CGFloat((bounce + 1) / 2) * bounceAmplitude)
                        // Slight opacity sway so dots fade as they
                        // dip — adds depth.
                        .opacity(0.55 + 0.45 * (bounce + 1) / 2)
                        .frame(width: 6, height: 6)
                }
                Spacer(minLength: 0)
            }
        }
    }
}

/// Voice-frequency-band bars. Each bar represents a log-spaced
/// slice of the human voice band (≈80 Hz – 4 kHz):
///
///   bar 0 → fundamentals + chest resonance
///   bar 3 → mid-formants
///   bar 6 → high formants + sibilants
///
/// Each bar's height reflects the FFT magnitude in its band, so the
/// silhouette reshapes itself as the user moves between vowels and
/// consonants — vowels light up the lower-mid bars (formants),
/// sibilants like "s" / "f" / "sh" light up the rightmost bars,
/// hum/voiced sounds light up the left bars.
///
/// Bars are vertically centered with `alignment: .center` so they
/// extend equally above and below the row's midline as their
/// magnitudes grow. A small baseline keeps the panel from looking
/// empty during silence.
private struct VoiceLevelBars: View {
    /// Per-band smoothed magnitudes (0…1). Index 0 = lowest
    /// frequency, last = highest.
    let bands: [Double]
    /// `false` while preparing/idle — bars hold at the silence
    /// baseline so the panel layout matches the recording state.
    let isActive: Bool

    /// Floor on bar amplitude so silence still shows a row of
    /// short dashes. Without this the HUD looks empty between
    /// utterances and reads as "not listening".
    private let baseline: Double = 0.12

    var body: some View {
        GeometryReader { geo in
            let totalSpacing = CGFloat(bands.count - 1) * 4
            let barWidth = max(4, (geo.size.width - totalSpacing) / CGFloat(bands.count))
            HStack(alignment: .center, spacing: 4) {
                ForEach(0..<bands.count, id: \.self) { i in
                    let amplitude = max(baseline, bands[i])
                    let h = CGFloat(amplitude) * geo.size.height
                    Capsule(style: .continuous)
                        .fill(Color.speakistPeach)
                        .frame(width: barWidth, height: max(h, 4))
                        .opacity(isActive ? 1.0 : 0.45)
                        // Snappy attack, gentler release — bars feel
                        // responsive to peaks but don't jitter at
                        // the noise floor. Tuning is at the
                        // controller's smoother; this just damps
                        // any per-frame visual drift.
                        .animation(.easeOut(duration: 0.06), value: amplitude)
                }
            }
            // Center alignment makes each bar grow equally above
            // and below the row's midline rather than from a
            // bottom baseline. Combined with per-bar magnitudes
            // this gives the classic "centered FFT" look.
            .frame(width: geo.size.width, height: geo.size.height, alignment: .center)
        }
    }
}
