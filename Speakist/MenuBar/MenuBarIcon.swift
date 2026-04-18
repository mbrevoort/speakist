import AppKit

/// Programmatic Speakist menu-bar glyph: a rounded speech bubble with a
/// five-bar waveform punched out of the middle. Drawn at ~18×18 so it
/// reads cleanly in the status bar.
///
/// The color is baked into the NSImage at draw time rather than relying on
/// NSStatusBarButton.contentTintColor, which is inconsistent. Black fills
/// are marked as template images so macOS auto-tints them to match the
/// menu bar appearance; non-black fills render as-drawn.
enum MenuBarIcon {
    /// Glyph dimensions, in points. macOS scales this for Retina automatically.
    static let size = NSSize(width: 18, height: 18)

    /// Returns an NSImage filled with the requested color, suitable for
    /// `NSStatusItem.button.image`.
    static func make(fill: NSColor = .black) -> NSImage {
        let image = NSImage(size: size, flipped: false) { rect in
            drawGlyph(in: rect, fill: fill)
            return true
        }
        // Template rendering only makes sense when the fill is neutral.
        let rgb = fill.usingColorSpace(.sRGB) ?? fill
        let isBlack = (rgb.redComponent == 0 && rgb.greenComponent == 0 && rgb.blueComponent == 0)
        image.isTemplate = isBlack
        image.accessibilityDescription = "Speakist"
        return image
    }

    private static func drawGlyph(in rect: NSRect, fill: NSColor) {
        // Normalize: draw in a 22-unit reference coordinate system and scale.
        let ref: CGFloat = 22
        let sx = rect.width / ref
        let sy = rect.height / ref
        NSGraphicsContext.current?.cgContext.scaleBy(x: sx, y: sy)

        // AppKit y-axis: 0 at bottom. Bubble occupies y ∈ [4.5, 18.5],
        // tail drops down to ~y = 1.
        let bubbleRect = NSRect(x: 2, y: 4.5, width: 18, height: 14)
        let cornerRadius: CGFloat = 3.5

        let path = NSBezierPath()
        path.windingRule = .evenOdd

        // Bubble outline
        path.append(NSBezierPath(roundedRect: bubbleRect, xRadius: cornerRadius, yRadius: cornerRadius))

        // Tail triangle dropping from the bubble's lower-left quadrant
        let tail = NSBezierPath()
        tail.move(to: NSPoint(x: 6.2, y: 5.2))
        tail.line(to: NSPoint(x: 3.4, y: 1.5))
        tail.line(to: NSPoint(x: 8.8, y: 5.2))
        tail.close()
        path.append(tail)

        // 5 waveform bars cut out of the bubble (via even-odd winding)
        let bars: [(x: CGFloat, height: CGFloat)] = [
            (5.5,   4),
            (8.25,  7),
            (11.0,  9),
            (13.75, 7),
            (16.5,  4),
        ]
        let barWidth: CGFloat = 1.6
        let midY: CGFloat = 11.5
        for bar in bars {
            let barRect = NSRect(
                x: bar.x - barWidth / 2,
                y: midY - bar.height / 2,
                width: barWidth,
                height: bar.height)
            let radius = barWidth / 2
            path.append(NSBezierPath(roundedRect: barRect, xRadius: radius, yRadius: radius))
        }

        fill.setFill()
        path.fill()
    }
}
