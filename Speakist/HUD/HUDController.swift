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
    /// 12-sample ring of recent RMS levels (0...1) for the waveform view.
    @Published var levels: [Float] = Array(repeating: 0, count: 12)

    private let preferences: Preferences
    private var panel: HUDPanel?
    private var levelSubscription: AnyCancellable?
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

    private func push(level: Float) {
        levels.removeFirst()
        levels.append(level)
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
    init<Content: View>(contentView: Content) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 360, height: 72),
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
        hosting.frame = NSRect(x: 0, y: 0, width: 360, height: 72)
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
        HStack(spacing: 12) {
            leading
                .frame(width: 20, height: 20)
            content
                .frame(maxWidth: .infinity)
                .frame(height: 32)
            timeLabel
                .frame(width: 60, alignment: .trailing)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(.ultraThinMaterial)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Color.black.opacity(0.08), lineWidth: 0.5)
        )
        .padding(4)
    }

    @ViewBuilder private var leading: some View {
        switch controller.state {
        case .preparing, .recording:
            // Brand mark on the leading edge, breathing subtly so the
            // HUD doesn't feel static. Replaces the previous generic
            // peach pulsing dot with the actual Speakist logo.
            SpeakistMark()
        case .transcribing:
            // Empty placeholder during transcribing — the wave-dot
            // animation in the content slot is the activity signal,
            // and a competing spinner here would be visual noise. The
            // 20×20 frame from the parent HStack keeps the column
            // width stable so the layout doesn't shift.
            Color.clear
        case .hidden:
            EmptyView()
        }
    }

    @ViewBuilder private var content: some View {
        switch controller.state {
        case .preparing:
            // Quiet placeholder while engine warms up — matches the
            // waveform's vertical footprint so the panel doesn't
            // resize when it flips to .recording.
            HStack(spacing: 6) {
                Text("Get ready…")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
        case .recording:
            WaveformView(levels: controller.levels, accentColor: Color.speakistPeach)
        case .transcribing:
            TranscribingIndicator()
        case .hidden:
            EmptyView()
        }
    }

    @ViewBuilder private var timeLabel: some View {
        switch controller.state {
        case .preparing:
            // Show "0:00" while preparing so the field is the same
            // width and the layout doesn't jump on flip.
            Text("0:00")
                .font(.system(size: 15, weight: .semibold, design: .monospaced))
                .foregroundStyle(.secondary)
        case .recording, .transcribing:
            // Frozen on `.transcribing` (timer was invalidated in
            // `setTranscribing`) but kept at full primary contrast so
            // the user can still read how long they spoke. Greying it
            // out would read as "this number is no longer valid".
            Text(formatTime(controller.elapsed))
                .font(.system(size: 15, weight: .semibold, design: .monospaced))
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

/// Mini Speakist mark — speech-bubble-with-waveform in peach gradient,
/// matching the SVG used on the marketing site (`web/src/components/
/// brand/logo.tsx`) and the design source (`design/Speakist.svg`).
/// Drawn in 64-unit space so the same coordinates from the SVG can be
/// used verbatim. Includes a gentle breathing animation so the HUD
/// feels alive without being distracting.
private struct SpeakistMark: View {
    @State private var pulsing = false

    var body: some View {
        ZStack {
            BubbleWithTailShape()
                .fill(
                    LinearGradient(
                        // Two-stop peach gradient — same #FFA98A → #FF7547
                        // pair the SVG uses, so the mark on Mac is
                        // pixel-recognizable next to the marketing site.
                        colors: [
                            Color(red: 1.0, green: 0.663, blue: 0.541),
                            Color(red: 1.0, green: 0.459, blue: 0.278),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
            BubbleBars()
        }
        .scaleEffect(pulsing ? 1.04 : 0.96)
        .animation(
            .easeInOut(duration: 0.85).repeatForever(autoreverses: true),
            value: pulsing
        )
        .onAppear { pulsing = true }
    }
}

/// The speech-bubble silhouette: rounded body + small angled tail at
/// the lower-left. Tail coordinates traced from the SVG's path data so
/// the proportions match.
private struct BubbleWithTailShape: Shape {
    func path(in rect: CGRect) -> Path {
        let s = rect.width / 64.0
        var p = Path()
        // Rounded body — close enough to the SVG's arc-corner-rect at
        // the sizes we render (16–32pt). The SVG arcs use radius 8 in
        // 64-unit space; matched here.
        p.addRoundedRect(
            in: CGRect(x: 8 * s, y: 10 * s, width: 50 * s, height: 38 * s),
            cornerSize: CGSize(width: 8 * s, height: 8 * s)
        )
        // Tail — three points forming the triangular pointer below
        // the body. SVG path: line to (26, 54.5), curve to (~24.3,
        // 53.8), line up to (24.3, 48). We approximate the tiny
        // bezier with a straight line; at the small render sizes the
        // difference is sub-pixel.
        p.move(to: CGPoint(x: 33 * s, y: 48 * s))
        p.addLine(to: CGPoint(x: 26 * s, y: 54.5 * s))
        p.addLine(to: CGPoint(x: 24.3 * s, y: 48 * s))
        p.closeSubpath()
        return p
    }
}

/// Five centered waveform bars inside the bubble. Heights asymmetric
/// (8–20–8) so the silhouette reads as "voice", not "equalizer". Center
/// bar is fully opaque; outer bars fade slightly for visual depth.
private struct BubbleBars: View {
    private struct Bar { let x: Double; let y: Double; let h: Double; let opacity: Double }
    private let bars: [Bar] = [
        Bar(x: 18.5, y: 25, h: 8,  opacity: 0.85),
        Bar(x: 24,   y: 22, h: 14, opacity: 0.90),
        Bar(x: 29.5, y: 19, h: 20, opacity: 1.00),
        Bar(x: 35,   y: 22, h: 14, opacity: 0.90),
        Bar(x: 40.5, y: 25, h: 8,  opacity: 0.85),
    ]

    var body: some View {
        GeometryReader { geo in
            let s = geo.size.width / 64.0
            ForEach(0..<bars.count, id: \.self) { i in
                Capsule()
                    .fill(Color.white.opacity(bars[i].opacity))
                    .frame(width: 3 * s, height: bars[i].h * s)
                    .position(
                        x: (bars[i].x + 1.5) * s,
                        y: (bars[i].y + bars[i].h / 2) * s
                    )
            }
        }
    }
}

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

private struct WaveformView: View {
    let levels: [Float]
    let accentColor: Color

    var body: some View {
        GeometryReader { geo in
            let barCount = max(levels.count, 1)
            let spacing: CGFloat = 3
            let barWidth = max((geo.size.width - CGFloat(barCount - 1) * spacing) / CGFloat(barCount), 3)
            HStack(spacing: spacing) {
                ForEach(levels.indices, id: \.self) { i in
                    // Keep a small resting height so the bars look like a waveform
                    // baseline even during silent moments.
                    let level = CGFloat(levels[i])
                    let h = max(level * geo.size.height, 4)
                    Capsule(style: .continuous)
                        .fill(accentColor)
                        .frame(width: barWidth, height: h)
                        .animation(.easeOut(duration: 0.12), value: levels[i])
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .center)
        }
    }
}
