import UIKit

/// Three-layout standard iOS keyboard: ABC (letters), 123 (numbers +
/// common punctuation), #+= (extended symbols). Mirrors Apple's stock
/// keyboard layout closely enough that App Review's "fully functional
/// keyboard" requirement is satisfied (4.5.5).
///
/// Key construction is fully spec-driven — `lettersLayout`, `numbersLayout`,
/// and `symbolsLayout` each return `[[Spec]]` that the renderer turns
/// into stack-of-stacks. Switching layout or shift state rebuilds; the
/// rebuild is fast (one stack tear-down + ~30 button creates) so we
/// don't try to mutate buttons in place — cleaner that way.
///
/// The host controller wires text insertion, layout/shift state, and
/// the globe key (whose `handleInputModeList(from:with:)` selector
/// lives on `UIInputViewController` — exposed via `onGlobeReady`).
enum QwertyLayout: Equatable {
    case letters
    case numbers
    case symbols
}

/// Three-state shift like Apple's: tap once → one-shot upper for the
/// next letter, tap again → caps lock, tap a third time → off.
enum ShiftState: Equatable {
    case off
    case oneShot
    case locked
}

/// Output of a key tap. The host translates these into edits via
/// `textDocumentProxy` and shift/layout transitions.
enum QwertyKey: Equatable {
    case insert(String)
    case backspace
    case shift
    case enter
    case space
    case switchLayout(QwertyLayout)
    case globe
}

final class QwertyKeyboardView: UIView {

    /// Tap callback for everything except `.globe` (which Apple's
    /// `handleInputModeList(from:with:)` selector owns — see `onGlobeReady`).
    var onKey: ((QwertyKey) -> Void)?

    /// Hand the globe button to the host so it can attach
    /// `handleInputModeList(from:with:)` for `.allTouchEvents`. That
    /// preserves Apple's standard tap-to-cycle / long-press-to-pick UX.
    var onGlobeReady: ((UIButton) -> Void)?

    var layout: QwertyLayout = .letters {
        didSet { if oldValue != layout { rebuild() } }
    }

    var shiftState: ShiftState = .off {
        didSet { if oldValue != shiftState { rebuild() } }
    }

    private let rowsStack: UIStackView = {
        let s = UIStackView()
        s.axis = .vertical
        s.distribution = .fillEqually
        s.spacing = 9
        s.translatesAutoresizingMaskIntoConstraints = false
        return s
    }()

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        addSubview(rowsStack)
        NSLayoutConstraint.activate([
            rowsStack.topAnchor.constraint(equalTo: topAnchor, constant: 5),
            rowsStack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 3),
            rowsStack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -3),
            rowsStack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -5)
        ])
        rebuild()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    // MARK: - Spec

    private struct Spec {
        let title: String?
        let image: String?
        let key: QwertyKey
        let widthClass: WidthClass
        let style: KeyStyle
    }

    private enum WidthClass {
        /// Letter-key reference width (1.0×).
        case standard
        /// Shift / delete (1.4×).
        case wide
        /// Bottom-row 123 / ABC / globe (1.4×).
        case bottomFunc
        /// Return key (2.0×).
        case bottomReturn
        /// Space — fills remaining width via low-hugging priority.
        case space
        /// Half-width invisible spacer used to indent row 2 (a-l).
        case insetSpacer
    }

    private enum KeyStyle {
        /// White (light) / dark gray (dark) — for letters, digits, symbols, spacebar.
        case primary
        /// Slightly darker — for shift, delete, return, layout switch, globe.
        case function
    }

    // MARK: - Build

    private func rebuild() {
        rowsStack.arrangedSubviews.forEach {
            rowsStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        let rows: [[Spec]]
        switch layout {
        case .letters: rows = lettersLayout()
        case .numbers: rows = numbersLayout()
        case .symbols: rows = symbolsLayout()
        }
        for row in rows {
            rowsStack.addArrangedSubview(makeRow(row))
        }
    }

    /// Build one horizontal row from a spec array. Width relationships
    /// are pinned to the first `.standard` button in the row so changing
    /// device width re-flows the whole row proportionally.
    private func makeRow(_ specs: [Spec]) -> UIStackView {
        let row = UIStackView()
        row.axis = .horizontal
        row.distribution = .fill
        row.alignment = .fill
        row.spacing = 6

        var views: [UIView] = []
        for spec in specs {
            if spec.widthClass == .insetSpacer {
                let v = UIView()
                v.translatesAutoresizingMaskIntoConstraints = false
                row.addArrangedSubview(v)
                views.append(v)
            } else {
                let b = makeButton(spec)
                row.addArrangedSubview(b)
                views.append(b)
            }
        }

        guard let refIdx = specs.firstIndex(where: { $0.widthClass == .standard }) else {
            return row
        }
        let ref = views[refIdx]
        for (i, spec) in specs.enumerated() where i != refIdx {
            let v = views[i]
            switch spec.widthClass {
            case .standard:
                v.widthAnchor.constraint(equalTo: ref.widthAnchor).isActive = true
            case .wide, .bottomFunc:
                v.widthAnchor.constraint(equalTo: ref.widthAnchor, multiplier: 1.4).isActive = true
            case .bottomReturn:
                v.widthAnchor.constraint(equalTo: ref.widthAnchor, multiplier: 2.0).isActive = true
            case .space:
                v.setContentHuggingPriority(.defaultLow, for: .horizontal)
                v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            case .insetSpacer:
                v.widthAnchor.constraint(equalTo: ref.widthAnchor, multiplier: 0.5).isActive = true
            }
        }
        return row
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
            b.titleLabel?.font = .systemFont(
                ofSize: spec.key == .space ? 15 : 22,
                weight: spec.key == .space ? .regular : .regular
            )
        case .function:
            b.setTitleColor(.label, for: .normal)
            b.titleLabel?.font = .systemFont(ofSize: 16, weight: .regular)
        }

        if let img = spec.image {
            let cfg = UIImage.SymbolConfiguration(pointSize: 19, weight: .regular)
            b.setImage(UIImage(systemName: img, withConfiguration: cfg), for: .normal)
            b.tintColor = .label
        } else if let title = spec.title {
            b.setTitle(title, for: .normal)
        }

        // Touch-down highlight (matches iOS keyboard's tap feedback).
        b.addAction(UIAction { [weak b] _ in
            b?.backgroundColor = UIColor.systemGray3
        }, for: .touchDown)
        b.addAction(UIAction { [weak b] _ in
            UIView.animate(withDuration: 0.12) {
                b?.backgroundColor = restingColor
            }
        }, for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])

        // Tap → onKey, except for globe (host owns that selector).
        let key = spec.key
        if case .globe = key {
            onGlobeReady?(b)
        } else {
            b.addAction(UIAction { [weak self] _ in
                self?.onKey?(key)
            }, for: .touchUpInside)
        }
        return b
    }

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

    // MARK: - Layouts

    private func lettersLayout() -> [[Spec]] {
        let isUpper = shiftState != .off
        let r1 = "qwertyuiop".map { letterSpec(String($0), upper: isUpper) }
        let r2letters = "asdfghjkl".map { letterSpec(String($0), upper: isUpper) }
        let r2 = [insetSpec()] + r2letters + [insetSpec()]
        let r3letters = "zxcvbnm".map { letterSpec(String($0), upper: isUpper) }

        let shiftIcon: String
        switch shiftState {
        case .off:     shiftIcon = "shift"
        case .oneShot: shiftIcon = "shift.fill"
        case .locked:  shiftIcon = "capslock.fill"
        }
        let shift = Spec(title: nil, image: shiftIcon, key: .shift,
                          widthClass: .wide, style: .function)
        let delete = Spec(title: nil, image: "delete.left", key: .backspace,
                           widthClass: .wide, style: .function)
        let r3 = [shift] + r3letters + [delete]

        let r4 = bottomRow(layoutSwitchTitle: "123",
                           layoutSwitchTarget: .numbers)

        return [Array(r1), r2, r3, r4]
    }

    private func numbersLayout() -> [[Spec]] {
        let r1 = "1234567890".map { plainSpec(String($0)) }
        let r2 = ["-", "/", ":", ";", "(", ")", "$", "&", "@", "\""].map { plainSpec($0) }

        let symSwitch = Spec(title: "#+=", image: nil,
                              key: .switchLayout(.symbols),
                              widthClass: .wide, style: .function)
        let r3items = [".", ",", "?", "!", "'"].map { plainSpec($0) }
        let delete = Spec(title: nil, image: "delete.left", key: .backspace,
                           widthClass: .wide, style: .function)
        let r3 = [symSwitch] + r3items + [delete]

        let r4 = bottomRow(layoutSwitchTitle: "ABC",
                           layoutSwitchTarget: .letters)

        return [Array(r1), Array(r2), r3, r4]
    }

    private func symbolsLayout() -> [[Spec]] {
        let r1 = ["[", "]", "{", "}", "#", "%", "^", "*", "+", "="].map { plainSpec($0) }
        let r2 = ["_", "\\", "|", "~", "<", ">", "€", "£", "¥", "•"].map { plainSpec($0) }

        let numSwitch = Spec(title: "123", image: nil,
                              key: .switchLayout(.numbers),
                              widthClass: .wide, style: .function)
        let r3items = [".", ",", "?", "!", "'"].map { plainSpec($0) }
        let delete = Spec(title: nil, image: "delete.left", key: .backspace,
                           widthClass: .wide, style: .function)
        let r3 = [numSwitch] + r3items + [delete]

        let r4 = bottomRow(layoutSwitchTitle: "ABC",
                           layoutSwitchTarget: .letters)

        return [Array(r1), Array(r2), r3, r4]
    }

    private func bottomRow(layoutSwitchTitle: String,
                           layoutSwitchTarget: QwertyLayout) -> [Spec] {
        let switchKey = Spec(title: layoutSwitchTitle, image: nil,
                              key: .switchLayout(layoutSwitchTarget),
                              widthClass: .bottomFunc, style: .function)
        let globe = Spec(title: nil, image: "globe", key: .globe,
                          widthClass: .bottomFunc, style: .function)
        let space = Spec(title: "space", image: nil, key: .space,
                          widthClass: .space, style: .primary)
        let returnKey = Spec(title: "return", image: nil, key: .enter,
                              widthClass: .bottomReturn, style: .function)
        return [switchKey, globe, space, returnKey]
    }

    // MARK: - Spec helpers

    private func letterSpec(_ s: String, upper: Bool) -> Spec {
        let v = upper ? s.uppercased() : s
        return Spec(title: v, image: nil, key: .insert(v),
                    widthClass: .standard, style: .primary)
    }

    private func plainSpec(_ s: String) -> Spec {
        Spec(title: s, image: nil, key: .insert(s),
             widthClass: .standard, style: .primary)
    }

    private func insetSpec() -> Spec {
        // .insetSpacer width is half a letter; never gets a button —
        // makeRow turns it into a transparent UIView for indentation.
        Spec(title: nil, image: nil, key: .insert(""),
             widthClass: .insetSpacer, style: .primary)
    }
}
