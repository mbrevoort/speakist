import UIKit

/// Speakist's typing surface: a single-panel symbols/numbers/punctuation
/// keyboard with native-feeling key-preview popups. There is **no
/// letters layout** by design — the `ABC` button delegates to
/// `advanceToNextInputMode()` so users get back to whatever keyboard
/// they had selected before, with full QWERTY + their personal
/// dictionary intact. Wispr Flow ships the same trick.
///
/// The four rows are fixed (no shift state, no panel switcher):
///
///   1: 1 2 3 4 5 6 7 8 9 0
///   2: - / : ; ( ) $ & @ "
///   3: . , ? ! ' ⌫
///   4: ABC · ▶ Flow · ↵ · 🌐
///
/// Extended symbols ([ ] { } # % ^ etc.) intentionally aren't surfaced;
/// the design assumes anyone needing them taps `ABC` and uses the
/// system keyboard's own `#+=` panel.
///
/// The host controller wires text insertion + the globe key (whose
/// `handleInputModeList(from:with:)` selector lives on
/// `UIInputViewController` — exposed via `onGlobeReady`).

/// Output of a key press. The host translates these via
/// `textDocumentProxy` (editing keys) or `advanceToNextInputMode()`
/// (the `.abc` button).
enum SymbolKey: Equatable {
    /// Plain insertion — digit, symbol, punctuation.
    case insert(String)
    case backspace
    /// Sends the host's return-key action (newline). The visual icon
    /// adapts to `UIReturnKeyType` via `setReturnKeyType(_:)` but the
    /// underlying behavior is always "insert \n".
    case `return`
    /// Switch to the user's previous keyboard. Maps to
    /// `UIInputViewController.advanceToNextInputMode()`.
    case abc
    /// Spacebar — inserts a literal space. Visually carries the
    /// Speakist watermark so users can identify the keyboard at a
    /// glance, but its behavior is identical to a stock spacebar.
    case space
}

final class SymbolKeyboardView: UIView {

    /// Tap callback for every key.
    var onKey: ((SymbolKey) -> Void)?

    private let rowsStack: UIStackView = {
        let s = UIStackView()
        s.axis = .vertical
        s.distribution = .fillEqually
        s.spacing = 9
        s.translatesAutoresizingMaskIntoConstraints = false
        return s
    }()

    /// Floating popup that magnifies the pressed character above the
    /// key. Mounted on `self` (above all rows) and repositioned
    /// per-press; hidden whenever no key is held.
    private let keyPreview = KeyPreviewView()

    /// Row-3 backspace key — captured during build so the bottom
    /// row's ABC and return buttons can anchor directly to its width
    /// (instead of going through a fragile global standard-width ref
    /// that mis-resolves when rows have different button counts).
    private weak var deleteButton: UIButton?

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        clipsToBounds = false   // let key preview draw above our top edge

        addSubview(rowsStack)
        addSubview(keyPreview)
        keyPreview.isHidden = true

        NSLayoutConstraint.activate([
            rowsStack.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            rowsStack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 3),
            rowsStack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -3),
            rowsStack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -5)
        ])
        build()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    // MARK: - Spec

    private struct Spec {
        let title: String?
        let image: String?
        let imagePointSize: CGFloat
        let key: SymbolKey
        let widthClass: WidthClass
        let style: KeyStyle
        /// Whether tapping this key shows the magnify popup. `false`
        /// for the bottom row's function buttons (ABC / Flow / return /
        /// globe) — Apple's keyboard never shows previews for those.
        let showsPreview: Bool
    }

    private enum WidthClass {
        /// Reference width — character keys in rows 1 / 2. The first
        /// `.standard` button anywhere in the keyboard becomes the
        /// global width reference.
        case standard
        /// 1.5× standard. Used for backspace AND for the bottom-row
        /// ABC + return buttons so all three end up identical width
        /// (matches the stock iOS layout's "function key" sizing).
        case wide
        /// Spacebar — fills remaining width via low hugging.
        case space
    }

    private enum KeyStyle {
        /// White (light) / dark gray (dark) — for character keys
        /// AND the spacebar (which is just a wide primary key with no
        /// label, mirroring the stock iOS spacebar's appearance).
        case primary
        /// Slightly darker — for delete, ABC, return.
        case function
    }

    // MARK: - Build

    /// Two-phase build, with **per-row** standard-width references
    /// (a single global ref over-constrains rows that have different
    /// button counts — row 3's six buttons vs rows 1/2's ten produced
    /// a width that overflowed the keyboard horizontally).
    ///
    ///   1. Skeleton — construct every row's UIStackView + buttons,
    ///      append to `rowsStack` (so cross-row anchors share an
    ///      ancestor), record the row-3 backspace button for later.
    ///   2. Constraints — for each row, pick its first `.standard`
    ///      button as the in-row reference; size other `.standard`
    ///      and `.wide` keys relative to that. The bottom row has no
    ///      `.standard` and instead anchors ABC + return to the
    ///      already-sized backspace from row 3, so all three function
    ///      keys (backspace, ABC, return) end up identical width.
    private func build() {
        let rows: [[Spec]] = [
            row1Numbers(),
            row2Symbols(),
            row3Punctuation(),
            row4Bottom()
        ]

        // Phase 1: skeleton.
        var built: [(specs: [Spec], buttons: [UIButton])] = []
        for specs in rows {
            let row = UIStackView()
            row.axis = .horizontal
            row.distribution = .fill
            row.alignment = .fill
            row.spacing = 6
            var buttons: [UIButton] = []
            for spec in specs {
                let b = makeButton(spec)
                row.addArrangedSubview(b)
                buttons.append(b)
                if spec.widthClass == .space {
                    b.setContentHuggingPriority(.defaultLow, for: .horizontal)
                    b.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
                }
                if spec.key == .backspace {
                    deleteButton = b
                }
            }
            rowsStack.addArrangedSubview(row)
            built.append((specs, buttons))
        }

        // Phase 2: width constraints.
        for (specs, buttons) in built {
            // In-row standard reference (rows 1, 2, 3 each have one).
            let inRowRef = specs.firstIndex(where: { $0.widthClass == .standard }).map { buttons[$0] }
            for (i, spec) in specs.enumerated() {
                let v = buttons[i]
                switch spec.widthClass {
                case .standard:
                    if let ref = inRowRef, v !== ref {
                        v.widthAnchor.constraint(equalTo: ref.widthAnchor).isActive = true
                    }
                case .wide:
                    if let ref = inRowRef {
                        // Row 3's backspace — sized as 1.5× the row's standard key.
                        v.widthAnchor.constraint(equalTo: ref.widthAnchor, multiplier: 1.5).isActive = true
                    } else if let bs = deleteButton {
                        // Bottom row (no .standard) — match the row-3
                        // backspace exactly so ABC, backspace, return
                        // all line up vertically into a tidy column.
                        v.widthAnchor.constraint(equalTo: bs.widthAnchor).isActive = true
                    }
                case .space:
                    // Hugging priorities applied during skeleton phase.
                    break
                }
            }
        }
    }

    private func row1Numbers() -> [Spec] {
        "1234567890".map { plain(String($0)) }
    }

    private func row2Symbols() -> [Spec] {
        ["-", "/", ":", ";", "(", ")", "$", "&", "@", "\""].map { plain($0) }
    }

    private func row3Punctuation() -> [Spec] {
        let punct = [".", ",", "?", "!", "'"].map { plain($0) }
        let delete = Spec(title: nil, image: "delete.left",
                          imagePointSize: 19,
                          key: .backspace, widthClass: .wide,
                          style: .function, showsPreview: false)
        return punct + [delete]
    }

    private func row4Bottom() -> [Spec] {
        let abc = Spec(title: "ABC", image: nil, imagePointSize: 0,
                       key: .abc, widthClass: .wide,
                       style: .function, showsPreview: false)
        // Empty spacebar — no label, mirroring the stock iOS spacebar.
        let space = Spec(title: nil, image: nil, imagePointSize: 0,
                         key: .space, widthClass: .space,
                         style: .primary, showsPreview: false)
        // Curved-arrow return glyph matching the stock iOS keyboard.
        // Same width as backspace / ABC.
        let ret = Spec(title: nil, image: "arrow.turn.down.left",
                       imagePointSize: 16,
                       key: .return, widthClass: .wide,
                       style: .function, showsPreview: false)
        return [abc, space, ret]
    }

    private func plain(_ s: String) -> Spec {
        Spec(title: s, image: nil, imagePointSize: 0,
             key: .insert(s), widthClass: .standard,
             style: .primary, showsPreview: true)
    }

    private func makeButton(_ spec: Spec) -> UIButton {
        let b = UIButton(type: .custom)
        b.translatesAutoresizingMaskIntoConstraints = false
        b.layer.cornerRadius = 5.5
        b.layer.shadowColor = UIColor.black.cgColor
        b.layer.shadowOpacity = 0.18
        b.layer.shadowRadius = 0
        b.layer.shadowOffset = CGSize(width: 0, height: 1)
        b.titleLabel?.adjustsFontSizeToFitWidth = true
        b.titleLabel?.minimumScaleFactor = 0.6
        b.titleLabel?.lineBreakMode = .byClipping

        let restingColor = restingBackground(for: spec.style)
        b.backgroundColor = restingColor

        switch spec.style {
        case .primary:
            b.setTitleColor(.label, for: .normal)
            b.titleLabel?.font = .systemFont(ofSize: 22, weight: .regular)
        case .function:
            b.setTitleColor(.label, for: .normal)
            b.titleLabel?.font = .systemFont(ofSize: 16, weight: .regular)
        }

        if let img = spec.image {
            let cfg = UIImage.SymbolConfiguration(pointSize: spec.imagePointSize, weight: .regular)
            b.setImage(UIImage(systemName: img, withConfiguration: cfg), for: .normal)
            b.tintColor = .label
        }
        if let title = spec.title {
            b.setTitle(title, for: .normal)
        }

        // Touch-down highlight — instant darken, mirrors stock keyboard.
        let pressedColor = pressedBackground(for: spec.style)
        b.addAction(UIAction { [weak self, weak b] _ in
            guard let b else { return }
            b.backgroundColor = pressedColor
            if spec.showsPreview {
                self?.showPreview(over: b, character: spec.title ?? "")
            }
            if spec.key == .backspace {
                self?.startBackspaceRepeat()
            }
        }, for: .touchDown)

        b.addAction(UIAction { [weak b] _ in
            UIView.animate(withDuration: 0.12) {
                b?.backgroundColor = restingColor
            }
        }, for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])

        b.addAction(UIAction { [weak self] _ in
            self?.hidePreview()
            self?.stopBackspaceRepeat()
        }, for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])

        let key = spec.key
        b.addAction(UIAction { [weak self] _ in
            self?.onKey?(key)
        }, for: .touchUpInside)

        return b
    }

    // MARK: - Backgrounds

    private func restingBackground(for style: KeyStyle) -> UIColor {
        switch style {
        case .primary:
            return UIColor { trait in
                trait.userInterfaceStyle == .dark
                    ? UIColor(white: 0.42, alpha: 1)
                    : .white
            }
        case .function:
            return UIColor { trait in
                trait.userInterfaceStyle == .dark
                    ? UIColor(white: 0.30, alpha: 1)
                    : UIColor(red: 0.671, green: 0.694, blue: 0.722, alpha: 1.0)
            }
        }
    }

    private func pressedBackground(for style: KeyStyle) -> UIColor {
        return UIColor.systemGray3
    }

    // MARK: - Key preview

    private func showPreview(over button: UIView, character: String) {
        guard !character.isEmpty else { return }
        keyPreview.character = character
        let frameInSelf = button.convert(button.bounds, to: self)
        keyPreview.layoutPreview(over: frameInSelf, in: self.bounds)
        keyPreview.isHidden = false
        bringSubviewToFront(keyPreview)
    }

    private func hidePreview() {
        keyPreview.isHidden = true
    }

    // MARK: - Backspace auto-repeat

    /// iOS native backspace fires once on touch-down, then begins
    /// repeating after a short delay, accelerating from "delete chars"
    /// to "delete words". We approximate with a two-stage timer: 450ms
    /// initial pause, then 90ms cadence (chars). Matches stock feel
    /// closely enough for users who hold to delete a phrase.
    private var backspaceTimer: Timer?

    private func startBackspaceRepeat() {
        // First delete already fired via touchUpInside? No — we fire it
        // on touchDown alongside the timer setup so users perceive the
        // delete as instant, not delayed by the touch-up.
        onKey?(.backspace)
        backspaceTimer?.invalidate()
        backspaceTimer = Timer.scheduledTimer(withTimeInterval: 0.45, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.backspaceTimer = Timer.scheduledTimer(withTimeInterval: 0.09, repeats: true) { [weak self] _ in
                self?.onKey?(.backspace)
            }
        }
    }

    private func stopBackspaceRepeat() {
        backspaceTimer?.invalidate()
        backspaceTimer = nil
    }
}

// MARK: - KeyPreviewView

/// Native-feeling magnifier popup over the pressed key. A
/// CAShapeLayer-drawn speech-bubble: the upper "balloon" is ~1.5×
/// wider than the key, the lower "neck" tapers down to exactly the
/// key's width, and the bottom edge meets the key's top edge with no
/// gap. Mirrors iOS's stock keyboard popup closely enough that
/// touch-and-hold doesn't read as a foreign UX.
///
/// All measurements relative to the key's frame so edge keys near
/// the screen border still produce a centered popup that's clamped
/// to stay on-screen.
private final class KeyPreviewView: UIView {
    var character: String = "" {
        didSet { label.text = character }
    }

    private let label: UILabel = {
        let l = UILabel()
        // Frame-based — `layoutPreview` repositions the label per
        // press. Autolayout (translates… = false) was placing the
        // label at intrinsic size at (0, 0), so the magnified character
        // landed flush left of the balloon instead of centered.
        l.translatesAutoresizingMaskIntoConstraints = true
        l.textAlignment = .center
        l.font = .systemFont(ofSize: 28, weight: .regular)
        l.textColor = .label
        return l
    }()

    /// Drawn directly into the layer so we get the curved-neck path
    /// instead of a plain rounded rect. Updated in `layoutPreview` once
    /// we know the actual key dimensions.
    private let shapeLayer: CAShapeLayer = {
        let l = CAShapeLayer()
        l.fillColor = UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? UIColor(white: 0.55, alpha: 1)
                : .white
        }.cgColor
        l.shadowColor = UIColor.black.cgColor
        l.shadowOpacity = 0.22
        l.shadowRadius = 4
        l.shadowOffset = CGSize(width: 0, height: 2)
        return l
    }()

    init() {
        super.init(frame: .zero)
        // Frame-based: showPreview() sets `frame` directly per-press.
        // Autolayout (translates… = false) was overriding our frame
        // back to (0, 0), pinning every preview flush-left of the
        // keyboard regardless of which key was tapped.
        translatesAutoresizingMaskIntoConstraints = true
        isUserInteractionEnabled = false
        layer.addSublayer(shapeLayer)
        addSubview(label)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    /// Position + reshape the preview over `keyFrame` (in the
    /// keyboard's coords), clamping horizontally to stay inside
    /// `bounds`. The shape is recomputed every press because the
    /// taper depends on key width and clamp offset.
    func layoutPreview(over keyFrame: CGRect, in bounds: CGRect) {
        // The "balloon" (upper area) is wider than the key; the "neck"
        // tapers down to the key's exact width. Total preview height
        // = balloon height + neck height (neck spans the key's
        // vertical extent so the popup overlaps the key entirely,
        // visually swallowing it).
        let widthMul: CGFloat = 1.5
        let balloonHeight: CGFloat = max(keyFrame.height + 16, 52)
        let neckHeight: CGFloat = keyFrame.height
        let totalHeight = balloonHeight + neckHeight
        let balloonWidth = keyFrame.width * widthMul

        // Default centered over the key, then clamp so the bubble
        // doesn't escape the keyboard horizontally.
        var x = keyFrame.midX - balloonWidth / 2
        x = max(2, min(x, bounds.width - balloonWidth - 2))
        let y = keyFrame.minY - balloonHeight
        let frameRect = CGRect(x: x, y: y, width: balloonWidth, height: totalHeight)
        frame = frameRect

        // Build the path in the layer's local coordinate space.
        // Geometry:
        //   • balloon: a rounded rect (radius 10) at the top, full width
        //   • shoulders: cubic curves on each side that taper from the
        //     balloon's bottom corners inward to the neck's top corners
        //   • neck: rectangle at the bottom matching the key's width,
        //     centered horizontally relative to the original key (not
        //     the balloon, in case clamping shifted the balloon)
        let neckOriginInLocal = keyFrame.minX - x
        let neckWidth = keyFrame.width
        let neckLeft = neckOriginInLocal
        let neckRight = neckOriginInLocal + neckWidth
        let balloonRadius: CGFloat = 10
        let shoulderHeight: CGFloat = 14   // vertical span of the taper

        let path = UIBezierPath()
        // Top-left of balloon (after radius)
        path.move(to: CGPoint(x: balloonRadius, y: 0))
        // Top edge → top-right
        path.addLine(to: CGPoint(x: balloonWidth - balloonRadius, y: 0))
        path.addArc(withCenter: CGPoint(x: balloonWidth - balloonRadius, y: balloonRadius),
                    radius: balloonRadius, startAngle: -.pi / 2, endAngle: 0, clockwise: true)
        // Right edge of balloon
        path.addLine(to: CGPoint(x: balloonWidth, y: balloonHeight - shoulderHeight))
        // Right shoulder taper down to the neck
        path.addCurve(
            to: CGPoint(x: neckRight, y: balloonHeight),
            controlPoint1: CGPoint(x: balloonWidth, y: balloonHeight - shoulderHeight / 2),
            controlPoint2: CGPoint(x: neckRight + 8, y: balloonHeight)
        )
        // Right side of neck
        path.addLine(to: CGPoint(x: neckRight, y: totalHeight))
        // Bottom of neck
        path.addLine(to: CGPoint(x: neckLeft, y: totalHeight))
        // Left side of neck
        path.addLine(to: CGPoint(x: neckLeft, y: balloonHeight))
        // Left shoulder taper from neck back out to balloon's left edge
        path.addCurve(
            to: CGPoint(x: 0, y: balloonHeight - shoulderHeight),
            controlPoint1: CGPoint(x: neckLeft - 8, y: balloonHeight),
            controlPoint2: CGPoint(x: 0, y: balloonHeight - shoulderHeight / 2)
        )
        // Left edge of balloon up to the top-left arc
        path.addLine(to: CGPoint(x: 0, y: balloonRadius))
        path.addArc(withCenter: CGPoint(x: balloonRadius, y: balloonRadius),
                    radius: balloonRadius, startAngle: .pi, endAngle: -.pi / 2, clockwise: true)
        path.close()

        shapeLayer.path = path.cgPath
        shapeLayer.frame = bounds   // shadow needs a frame, not just a path

        // Center the magnified character within the balloon (above
        // the neck), not the full preview frame.
        label.frame = CGRect(x: 0, y: 0, width: balloonWidth, height: balloonHeight)
    }
}
