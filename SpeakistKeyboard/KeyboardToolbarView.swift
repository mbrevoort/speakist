import UIKit

/// Top toolbar of the Speakist keyboard. Two regions:
///
///   • leading — Speakist app icon. Pure identification — not interactive.
///   • trailing — mode-aware action button. In `.typing` it's a peach
///     "Start Speakist" pill; in `.startSession` / `.beginSpeaking`
///     it flips to a small circular X (modal-close style) that tears
///     down any in-flight session; in `.listening` / `.transient` it
///     hides entirely (the speakistContainer's ✓/✕ takes over).
///
/// Below the toolbar's content, a 4pt animated rainbow accent strip
/// carries the brand palette across the full width — same five colors
/// as the Mac HUD's angular border, animated by sliding a 2× wide
/// gradient leftward in a seamless loop. CABasicAnimation on a single
/// CAGradientLayer's `position.x` runs entirely on the GPU, so the
/// motion costs effectively nothing even on older devices.
final class KeyboardToolbarView: UIView {

    /// Tap callback for the trailing action button. Caller inspects
    /// the current mode to decide whether to start or cancel.
    var onAction: (() -> Void)?

    /// Tap callback for the leading Speakist brand icon. Wired to
    /// open the main Speakist app via URL scheme so users can jump
    /// from the keyboard to the app without leaving the host
    /// manually (useful for settings, history, balance top-up, etc.).
    var onBrandTap: (() -> Void)?

    enum Mode {
        /// Typing — show "Start Speakist" (peach pill).
        case typing
        /// Pre-listening states — show "Cancel" (coral pill).
        case cancellable
        /// Listening / transcribing — hide the action button entirely;
        /// speakistContainer's ✓/✕ buttons drive the lifecycle.
        case hidden
    }

    func setMode(_ mode: Mode) {
        switch mode {
        case .typing:
            actionButton.isHidden = false
            actionButton.isEnabled = true
            applyStartStyle()
        case .cancellable:
            actionButton.isHidden = false
            actionButton.isEnabled = true
            applyCancelStyle()
        case .hidden:
            actionButton.isHidden = true
        }
    }

    /// Disable the action button without changing its label (e.g. while
    /// the host app is mid-launch). Greyed-out + non-interactive but
    /// still visible so the user sees "in flight, hold tight".
    func setActionEnabled(_ enabled: Bool) {
        actionButton.isEnabled = enabled
        actionButton.alpha = enabled ? 1.0 : 0.55
    }

    /// Show / hide a coral warning banner overlaid on the toolbar.
    /// Used for the "Allow Full Access" gate — the keyboard can't
    /// talk to the main app without it, so we surface a directive
    /// instead of hiding the missing capability.
    func setWarning(_ message: String?) {
        if let message {
            warningLabel.text = message
            warningOverlay.isHidden = false
        } else {
            warningOverlay.isHidden = true
        }
    }

    // MARK: - Subviews

    private let brandIcon: UIImageView = {
        let v = UIImageView()
        v.translatesAutoresizingMaskIntoConstraints = false
        v.contentMode = .scaleAspectFit
        // Loaded from the keyboard target's own asset catalog
        // (SpeakistKeyboard/Resources/Assets.xcassets/BrandIcon.imageset).
        // Falls back to a generic mic glyph if the asset is missing
        // so we never crash on a fresh checkout that hasn't run the
        // sips downscaling step.
        v.image = UIImage(named: "BrandIcon")
            ?? UIImage(systemName: "waveform.circle.fill")
        v.layer.cornerRadius = 6
        v.clipsToBounds = true
        // Required for tap-gesture recognizers to fire on UIImageView
        // (it ships with isUserInteractionEnabled = false by default).
        v.isUserInteractionEnabled = true
        v.accessibilityLabel = "Open Speakist"
        v.accessibilityTraits = .button
        v.isAccessibilityElement = true
        return v
    }()

    private let actionButton: UIButton = {
        let b = UIButton(type: .system)
        b.translatesAutoresizingMaskIntoConstraints = false
        var cfg = UIButton.Configuration.filled()
        cfg.title = "Start Speakist"
        cfg.cornerStyle = .capsule
        cfg.baseBackgroundColor = .speakistPeach
        cfg.baseForegroundColor = .white
        cfg.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 18, bottom: 8, trailing: 18)
        cfg.attributedTitle = AttributedString("Start Speakist", attributes: AttributeContainer([
            .font: UIFont.systemFont(ofSize: 15, weight: .semibold)
        ]))
        b.configuration = cfg
        b.layer.shadowColor = UIColor.black.cgColor
        b.layer.shadowOpacity = 0.16
        b.layer.shadowRadius = 4
        b.layer.shadowOffset = CGSize(width: 0, height: 2)
        return b
    }()

    /// Rainbow accent below the toolbar's main content. Five-color
    /// linear gradient using the Speakist palette — same colors as the
    /// Mac HUD's angular border, but laid horizontally because there
    /// isn't a perimeter to wrap. Static (no animation) so it reads as
    /// a brand element rather than as activity feedback.
    private let rainbowStrip = RainbowStripView()

    private let warningOverlay: UIView = {
        let v = UIView()
        v.translatesAutoresizingMaskIntoConstraints = false
        v.backgroundColor = .speakistCoral
        v.isHidden = true
        v.isUserInteractionEnabled = false
        return v
    }()

    private let warningLabel: UILabel = {
        let l = UILabel()
        l.translatesAutoresizingMaskIntoConstraints = false
        l.textColor = .white
        l.textAlignment = .center
        l.font = .systemFont(ofSize: 13, weight: .semibold)
        l.numberOfLines = 1
        l.adjustsFontSizeToFitWidth = true
        l.minimumScaleFactor = 0.7
        return l
    }()

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        addSubview(brandIcon)
        addSubview(actionButton)
        addSubview(rainbowStrip)
        addSubview(warningOverlay)
        warningOverlay.addSubview(warningLabel)

        NSLayoutConstraint.activate([
            // Brand icon sits in the upper portion of the toolbar
            // (everything above the rainbow strip).
            brandIcon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            brandIcon.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -2),
            brandIcon.widthAnchor.constraint(equalToConstant: 28),
            brandIcon.heightAnchor.constraint(equalToConstant: 28),

            actionButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            actionButton.centerYAnchor.constraint(equalTo: brandIcon.centerYAnchor),
            actionButton.leadingAnchor.constraint(greaterThanOrEqualTo: brandIcon.trailingAnchor, constant: 8),

            // Rainbow strip pinned to the bottom edge — visually
            // separates the toolbar from the symbol keyboard below.
            rainbowStrip.leadingAnchor.constraint(equalTo: leadingAnchor),
            rainbowStrip.trailingAnchor.constraint(equalTo: trailingAnchor),
            rainbowStrip.bottomAnchor.constraint(equalTo: bottomAnchor),
            rainbowStrip.heightAnchor.constraint(equalToConstant: 4),

            warningOverlay.topAnchor.constraint(equalTo: topAnchor),
            warningOverlay.leadingAnchor.constraint(equalTo: leadingAnchor),
            warningOverlay.trailingAnchor.constraint(equalTo: trailingAnchor),
            warningOverlay.bottomAnchor.constraint(equalTo: rainbowStrip.topAnchor),
            warningLabel.leadingAnchor.constraint(equalTo: warningOverlay.leadingAnchor, constant: 14),
            warningLabel.trailingAnchor.constraint(equalTo: warningOverlay.trailingAnchor, constant: -14),
            warningLabel.centerYAnchor.constraint(equalTo: warningOverlay.centerYAnchor)
        ])

        actionButton.addAction(UIAction { [weak self] _ in self?.onAction?() }, for: .touchUpInside)

        // Tap on the brand icon → open the main app. UIImageView
        // doesn't have a UIControl-style action API, so use a
        // UITapGestureRecognizer that calls back to the host.
        let tap = UITapGestureRecognizer(target: self, action: #selector(brandTapped))
        brandIcon.addGestureRecognizer(tap)
    }

    @objc private func brandTapped() {
        onBrandTap?()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    /// Wide peach pill labelled "Start Speakist" — primary CTA when
    /// the keyboard is just being used for typing.
    private func applyStartStyle() {
        var cfg = UIButton.Configuration.filled()
        cfg.cornerStyle = .capsule
        cfg.baseBackgroundColor = .speakistPeach
        cfg.baseForegroundColor = .white
        cfg.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 18, bottom: 8, trailing: 18)
        cfg.attributedTitle = AttributedString("Start Speakist", attributes: AttributeContainer([
            .font: UIFont.systemFont(ofSize: 15, weight: .semibold)
        ]))
        cfg.image = nil
        actionButton.configuration = cfg
        actionButton.alpha = 1.0
        actionButton.layer.shadowOpacity = 0.16
    }

    /// Small circular X (modal-close style). Subtle gray-on-translucent
    /// — *not* coral or red — so it reads as "dismiss this overlay"
    /// rather than as a destructive action.
    private func applyCancelStyle() {
        var cfg = UIButton.Configuration.filled()
        cfg.cornerStyle = .capsule
        cfg.baseBackgroundColor = .tertiarySystemFill
        cfg.baseForegroundColor = .secondaryLabel
        cfg.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8)
        cfg.image = UIImage(systemName: "xmark",
                            withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .bold))
        cfg.title = nil
        cfg.attributedTitle = nil
        actionButton.configuration = cfg
        actionButton.alpha = 1.0
        // Drop the shadow on the cancel button — flatter / quieter than
        // the prominent peach pill.
        actionButton.layer.shadowOpacity = 0
    }
}

// MARK: - RainbowStripView

/// Animated linear gradient using the five-color Speakist palette,
/// laid horizontally. The Mac HUD wraps the same palette as an
/// angular sweep around its border; here we approximate the same
/// "ambient motion" feel by sliding a 2× wide gradient leftward in
/// a seamless loop.
///
/// The palette is duplicated end-to-end so the gradient is twice the
/// width of the visible strip; animating its `position.x` by exactly
/// `bounds.width` over the full period puts the second-half copy
/// where the first-half copy started — colors line up exactly, no
/// visible seam at loop boundaries.
///
/// Performance: a single CABasicAnimation on a CAGradientLayer's
/// `position.x` runs entirely on Core Animation's render server (GPU
/// composition, no per-frame CPU work), so the motion costs nothing
/// noticeable even on older devices. The strip can stay animated for
/// the entire keyboard session without affecting battery.
private final class RainbowStripView: UIView {
    private let gradient: CAGradientLayer = {
        let g = CAGradientLayer()
        // Double the palette so the layer (2× width) tiles seamlessly
        // when it slides one full bounds-width.
        let palette: [CGColor] = [
            UIColor.speakistPeach.cgColor,
            UIColor.speakistCoral.cgColor,
            UIColor.speakistMustard.cgColor,
            UIColor.speakistSage.cgColor,
            UIColor.speakistPlum.cgColor
        ]
        g.colors = palette + palette + [UIColor.speakistPeach.cgColor]
        // Eleven evenly-spaced stops over [0, 1] so each color band
        // gets the same visible width and the seam between cycles
        // (last stop = first color) is invisible.
        g.locations = (0...10).map { NSNumber(value: Double($0) / 10.0) }
        g.startPoint = CGPoint(x: 0, y: 0.5)
        g.endPoint   = CGPoint(x: 1, y: 0.5)
        return g
    }()

    /// Seconds per one full palette cycle. Tuned to feel ambient
    /// rather than urgent; the Mac HUD uses 6s on its angular border
    /// but a horizontal strip needs faster motion to read as moving
    /// at all (the linear sweep is less attention-grabbing than the
    /// rotational one). 4s is the sweet spot — visibly alive, not
    /// distracting from the keys below.
    private let period: CFTimeInterval = 4.0

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        layer.addSublayer(gradient)
        layer.masksToBounds = true   // hide the second-half overflow
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        ensureGradientFrame()
        ensureAnimating()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // CAAnimations are removed when a layer leaves the window
        // tree (keyboard dismiss). Re-attach on re-add so the strip
        // resumes motion when the keyboard re-presents.
        if window != nil {
            ensureGradientFrame()
            ensureAnimating()
        }
    }

    /// Resize the gradient to 2× the strip's width, with implicit
    /// CALayer animations disabled — without `setDisableActions`,
    /// every frame change triggers a 0.25s implicit fade/translate
    /// that fights the ongoing slide animation.
    private func ensureGradientFrame() {
        guard bounds.width > 0 else { return }
        let target = CGRect(x: 0, y: 0, width: bounds.width * 2, height: bounds.height)
        guard gradient.frame != target else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        gradient.frame = target
        CATransaction.commit()
    }

    /// Re-attach the slide animation. Removes any prior copy so a
    /// bounds change (rotation, keyboard re-layout) updates the
    /// `toValue` to the new width. Driven by `transform.translation.x`
    /// rather than `position.x` because translation animations layer
    /// on top of any positional layout work CA does behind the scenes
    /// and don't get clobbered when a parent re-layouts the gradient.
    private func ensureAnimating() {
        guard bounds.width > 0 else { return }
        gradient.removeAnimation(forKey: "rainbowSlide")
        let anim = CABasicAnimation(keyPath: "transform.translation.x")
        anim.fromValue = 0
        anim.toValue   = -bounds.width
        anim.duration = period
        anim.repeatCount = .infinity
        anim.isRemovedOnCompletion = false
        anim.timingFunction = CAMediaTimingFunction(name: .linear)
        gradient.add(anim, forKey: "rainbowSlide")
    }
}
