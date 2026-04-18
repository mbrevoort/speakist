import Foundation
import AppKit
import SwiftUI
import Combine

enum HUDState: Equatable {
    case hidden
    case recording
    case transcribing
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

    func showRecording() {
        guard preferences.showHUD else { return }
        if panel == nil {
            panel = HUDPanel(contentView: HUDView(controller: self))
        }
        state = .recording
        elapsed = 0
        startTime = Date()
        levels = Array(repeating: 0, count: 12)
        panel?.presentNearCursor()
        startTimer()
    }

    func setTranscribing() {
        state = .transcribing
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

/// Borderless, non-activating panel positioned near the cursor.
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

    func presentNearCursor() {
        let cursor = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { NSMouseInRect(cursor, $0.frame, false) }) ?? NSScreen.main
        guard let frame = screen?.visibleFrame else { return }

        let w = self.frame.width
        let h = self.frame.height
        var x = cursor.x - w/2
        var y = cursor.y + 28
        x = max(frame.minX + 8, min(x, frame.maxX - w - 8))
        y = max(frame.minY + 8, min(y, frame.maxY - h - 8))

        self.setFrameOrigin(NSPoint(x: x, y: y))
        self.alphaValue = 0
        self.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.12
            self.animator().alphaValue = 1
        }
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
}

// MARK: - HUD view

private struct HUDView: View {
    @ObservedObject var controller: HUDController

    var body: some View {
        HStack(spacing: 12) {
            leading
                .frame(width: 20, height: 20)
            WaveformView(levels: controller.levels, accentColor: Color.speakistPeach)
                .frame(maxWidth: .infinity)
                .frame(height: 32)
            Text(formatTime(controller.elapsed))
                .font(.system(size: 15, weight: .semibold, design: .monospaced))
                .foregroundColor(.primary)
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
        case .recording:
            PulsingDot()
        case .transcribing:
            ProgressView().controlSize(.small)
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
