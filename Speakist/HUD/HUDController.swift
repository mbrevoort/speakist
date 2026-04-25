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

    /// Anchor the HUD just below the focused text field if the
    /// Accessibility API can give us its on-screen bounds; otherwise
    /// fall back to the mouse cursor (legacy behavior). Either way,
    /// clamp to the visible screen so the panel never lands off-edge.
    func presentAnchoredToFocusedField() {
        let anchor = HUDPanel.focusedFieldRect() ?? mouseAnchorRect()
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

    /// Read the system-wide focused UI element's on-screen rect via
    /// the Accessibility API and convert it to AppKit's bottom-left
    /// coordinate space. Returns nil when AX is denied, no element is
    /// focused, or the focused element doesn't expose position+size
    /// (rare for text fields, common for some Electron apps).
    static func focusedFieldRect() -> NSRect? {
        guard AXIsProcessTrusted() else { return nil }

        let systemWide = AXUIElementCreateSystemWide()
        var focusedRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            systemWide, kAXFocusedUIElementAttribute as CFString, &focusedRef
        ) == .success, let focused = focusedRef else { return nil }
        let element = focused as! AXUIElement

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

        // AX position is in screen-flipped coords (origin top-left of
        // the primary screen). AppKit windows use bottom-left origin
        // relative to the screen the point falls on. Convert by
        // subtracting from the primary screen's height.
        guard let primary = NSScreen.screens.first else { return nil }
        let primaryHeight = primary.frame.height
        let flippedY = primaryHeight - origin.y - size.height
        return NSRect(x: origin.x, y: flippedY, width: size.width, height: size.height)
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
            PulsingDot()
        case .transcribing:
            // Same dimensions as PulsingDot so the layout doesn't
            // shift when state flips. Spinner is meaningful — it
            // tells the user something is in flight.
            ProgressView().controlSize(.small)
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
            Text(formatTime(controller.elapsed))
                .font(.system(size: 15, weight: .semibold, design: .monospaced))
                .foregroundStyle(controller.state == .transcribing ? .secondary : .primary)
        case .hidden:
            EmptyView()
        }
    }

    private func formatTime(_ t: TimeInterval) -> String {
        let total = Int(t)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

private struct PulsingDot: View {
    @State private var phase = false
    var body: some View {
        Circle()
            .fill(Color.speakistPeach)
            .scaleEffect(phase ? 1.0 : 0.7)
            .opacity(phase ? 1.0 : 0.6)
            .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: phase)
            .onAppear { phase = true }
    }
}

/// "Transcribing…" with three traveling-shimmer dots that march
/// left-to-right. Using a TimelineView so the animation runs on a
/// real clock and looks alive even during a long upload.
private struct TranscribingIndicator: View {
    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 8) {
                Text("Transcribing")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.primary)
                HStack(spacing: 3) {
                    ForEach(0..<3, id: \.self) { i in
                        let phase = (t * 1.4 + Double(i) * 0.22)
                            .truncatingRemainder(dividingBy: 1.0)
                        // Triangle wave so each dot fades in then out.
                        let alpha = 0.25 + 0.75 * (1 - abs(phase - 0.5) * 2)
                        Circle()
                            .fill(Color.speakistPeach.opacity(alpha))
                            .frame(width: 5, height: 5)
                    }
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
