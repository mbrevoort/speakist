import UIKit

/// Speakist custom keyboard extension.
///
/// ## What ships
///
/// A complete iOS keyboard (ABC / 123 / #+= layouts via `QwertyKeyboardView`)
/// plus a slim Speakist activation strip at the top. The strip is the
/// only thing that distinguishes us from the system keyboard visually
/// — letters work exactly the way users expect, so the keyboard
/// satisfies App Review guideline 4.5.5 ("provide a fully functional
/// keyboard").
///
/// ## Display modes
///
///   * `.typing` — strip + QWERTY (default).
///   * `.startSession` / `.beginSpeaking` / `.listening` / `.transient`
///     — strip + the Speakist controls (existing primary button + ✓/✕
///     + waveform). QWERTY is hidden under the controls; the user can
///     return to typing by tapping the strip's ✕ (or by completing /
///     cancelling the session).
///
/// Modes flip in two directions:
///
///   * Explicit user action: tap-strip in `.typing` activates Speakist;
///     tap-strip in non-listening Speakist modes returns to typing
///     (and Darwin-cancels any in-flight session).
///   * Reconcile from session: every Darwin `appStateChanged` and
///     every `textDidChange` re-reads `AppGroupBridge.sessionStatus`
///     and maps it into the correct mode. Done state in particular
///     auto-returns to `.typing` so the user can continue editing.
///
/// ## Constraints (all imposed by iOS, unchanged from prior versions)
///
///   * This process can NOT touch the microphone — `AVAudioSession`
///     from an extension hard-fails, regardless of entitlements. The
///     containing app holds the audio session.
///   * IPC with the main app requires "Allow Full Access" — without
///     it we degrade to typing-only and surface a coral banner in the
///     strip. We never break the keyboard.
///   * Bringing the main app foreground from an extension uses the
///     responder-chain walk to a `UIScene`'s
///     `openURL:options:completionHandler:` — `extensionContext.open`
///     is Today-widget-only and the legacy 1-arg `openURL:` is force-
///     returned `false` on iOS 18+.
final class KeyboardViewController: UIInputViewController {

    // MARK: - Display mode

    private enum DisplayMode {
        case typing
        case startSession
        case beginSpeaking
        case listening
        case transient
    }

    private var displayMode: DisplayMode = .typing {
        didSet {
            if oldValue != displayMode {
                applyDisplayMode(animated: true)
            }
        }
    }

    /// Set to `true` immediately after the user taps the activation
    /// strip and we kick the URL open. Suppresses one round of
    /// `reconcileFromSession` so a stale `.idle` reading from
    /// AppGroupBridge (the main app hasn't transitioned yet) doesn't
    /// flip us right back to `.typing`. Cleared on the next
    /// `appStateChanged` Darwin or after a 6-second safety window.
    private var suppressReconcile = false
    private var suppressReconcileExpiry: Date?

    // MARK: - Top strip (always visible)

    /// Slim 40pt strip at the top of the keyboard. Always mounted;
    /// its appearance + tap behavior change per `displayMode`. In
    /// `.typing` it's a peach activation pill ("Tap to dictate with
    /// Speakist"); in `.listening` it becomes a status banner; in the
    /// no-Full-Access state it becomes a coral warning that explains
    /// the missing toggle.
    private let speakistStrip = UIControl()
    private let stripIcon = UIImageView()
    private let stripLabel: UILabel = {
        let l = UILabel()
        l.translatesAutoresizingMaskIntoConstraints = false
        l.font = .systemFont(ofSize: 14, weight: .medium)
        l.textAlignment = .center
        l.adjustsFontSizeToFitWidth = true
        l.minimumScaleFactor = 0.7
        l.numberOfLines = 1
        return l
    }()
    private let stripTrailing = UIImageView()

    // MARK: - Typing surface

    private let qwerty = QwertyKeyboardView()

    // MARK: - Speakist surface

    /// Container holding the existing Speakist controls (primary CTA,
    /// status label, footer, listening row). Sits in the same frame
    /// as `qwerty` and gets toggled visible when `displayMode` is
    /// anything other than `.typing`.
    private let speakistContainer: UIView = {
        let v = UIView()
        v.translatesAutoresizingMaskIntoConstraints = false
        v.isHidden = true
        return v
    }()

    private let primaryButton: UIButton = {
        let b = UIButton(type: .system)
        b.translatesAutoresizingMaskIntoConstraints = false
        var cfg = UIButton.Configuration.filled()
        cfg.title = "Start Speakist"
        cfg.image = KeyboardViewController.makeBrandIcon()
        cfg.imagePadding = 10
        cfg.baseBackgroundColor = .speakistPlum
        cfg.baseForegroundColor = .white
        cfg.cornerStyle = .large
        cfg.contentInsets = NSDirectionalEdgeInsets(top: 14, leading: 22, bottom: 14, trailing: 22)
        cfg.attributedTitle = AttributedString("Start Speakist", attributes: AttributeContainer([
            .font: UIFont.systemFont(ofSize: 17, weight: .semibold)
        ]))
        b.configuration = cfg
        return b
    }()

    private let statusLabel: UILabel = {
        let l = UILabel()
        l.translatesAutoresizingMaskIntoConstraints = false
        l.textAlignment = .center
        l.font = .systemFont(ofSize: 13, weight: .medium)
        l.textColor = .secondaryLabel
        l.numberOfLines = 0
        l.text = "Tap Start Speakist to dictate"
        return l
    }()

    private let footerLabel: UILabel = {
        let l = UILabel()
        l.translatesAutoresizingMaskIntoConstraints = false
        l.textAlignment = .center
        l.font = .systemFont(ofSize: 11, weight: .regular)
        l.textColor = .tertiaryLabel
        l.numberOfLines = 0
        l.text = "Apple requires Speakist to be open to use the microphone from a keyboard."
        return l
    }()

    private let waveformView: WaveformView = {
        let v = WaveformView()
        v.translatesAutoresizingMaskIntoConstraints = false
        v.isHidden = true
        return v
    }()

    private let finishButton: UIButton = {
        let b = UIButton(type: .system)
        b.translatesAutoresizingMaskIntoConstraints = false
        var cfg = UIButton.Configuration.filled()
        cfg.image = UIImage(systemName: "checkmark")?
            .withConfiguration(UIImage.SymbolConfiguration(pointSize: 24, weight: .bold))
        cfg.baseBackgroundColor = .speakistSage
        cfg.baseForegroundColor = .white
        cfg.cornerStyle = .capsule
        cfg.contentInsets = NSDirectionalEdgeInsets(top: 16, leading: 30, bottom: 16, trailing: 30)
        b.configuration = cfg
        b.isHidden = true
        b.accessibilityLabel = "Finish dictation"
        return b
    }()

    private let cancelButton: UIButton = {
        let b = UIButton(type: .system)
        b.translatesAutoresizingMaskIntoConstraints = false
        var cfg = UIButton.Configuration.gray()
        cfg.image = UIImage(systemName: "xmark")?
            .withConfiguration(UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold))
        cfg.baseForegroundColor = .speakistCoral
        cfg.cornerStyle = .capsule
        cfg.contentInsets = NSDirectionalEdgeInsets(top: 16, leading: 22, bottom: 16, trailing: 22)
        b.configuration = cfg
        b.isHidden = true
        b.accessibilityLabel = "Cancel dictation"
        return b
    }()

    // MARK: - State

    private var darwinTokens: [UUID] = []
    private var lastAppliedSequence: Int = 0

    /// Runs at display-link cadence while listening, polls the App
    /// Group's mic-level slot, drives the WaveformView. Torn down
    /// outside `.listening` so we're not burning CPU.
    private var levelPollLink: CADisplayLink?

    /// Pre-allocated haptic generators. `prepare()` is called both
    /// here at construction time and in `viewDidAppear` — without
    /// the warm-up call the first tap routinely drops on iPhones
    /// that haven't fired the Taptic Engine recently.
    private let mediumImpact = UIImpactFeedbackGenerator(style: .medium)
    private let heavyImpact = UIImpactFeedbackGenerator(style: .heavy)
    private let lightImpact = UIImpactFeedbackGenerator(style: .light)
    private let successNotification = UINotificationFeedbackGenerator()

    /// App counts as "hot" when it wrote a foreground heartbeat
    /// within ~25 seconds, or when there's a live session. Drives
    /// whether tap-strip needs to relaunch the app (`.startSession`
    /// CTA) or can go straight to `.beginSpeaking`.
    private var appIsHot: Bool {
        if sessionIsLive() { return true }
        guard let defaults = AppGroupBridge.defaults else { return false }
        let stamp = defaults.double(forKey: AppGroupBridge.Key.lastForegroundAt)
        guard stamp > 0 else { return false }
        return Date().timeIntervalSince1970 - stamp < 25
    }

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? UIColor(white: 0.13, alpha: 1)
                : UIColor(red: 0.823, green: 0.835, blue: 0.851, alpha: 1.0)
        }
        setupLayout()
        wireQwerty()
        wireSpeakistControls()
        wireStripTap()
        observeAppState()
        applyDisplayMode(animated: false)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        publishHostBundleID()
        reconcileFromSession()
        updateAutoShift()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Warm haptics so the first key tap reliably fires the Taptic
        // Engine. Without this the very first interaction often feels
        // silent regardless of the code path being correct.
        mediumImpact.prepare()
        heavyImpact.prepare()
        lightImpact.prepare()
        successNotification.prepare()
    }

    override func textDidChange(_ textInput: UITextInput?) {
        super.textDidChange(textInput)
        // Driven both by our own insertions AND by the host app
        // updating its document — either way we want auto-cap to
        // re-evaluate and the strip to reflect any external session
        // state changes.
        reconcileFromSession()
        updateAutoShift()
    }

    deinit {
        darwinTokens.forEach(DarwinNotifier.shared.remove)
        levelPollLink?.invalidate()
    }

    // MARK: - Layout

    private func setupLayout() {
        setupSpeakistStrip()
        setupSpeakistContainer()

        view.addSubview(speakistStrip)
        view.addSubview(qwerty)
        view.addSubview(speakistContainer)

        NSLayoutConstraint.activate([
            speakistStrip.topAnchor.constraint(equalTo: view.topAnchor),
            speakistStrip.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            speakistStrip.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            speakistStrip.heightAnchor.constraint(equalToConstant: 42),

            qwerty.topAnchor.constraint(equalTo: speakistStrip.bottomAnchor),
            qwerty.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            qwerty.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            qwerty.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            speakistContainer.topAnchor.constraint(equalTo: speakistStrip.bottomAnchor),
            speakistContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            speakistContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            speakistContainer.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
    }

    private func setupSpeakistStrip() {
        speakistStrip.translatesAutoresizingMaskIntoConstraints = false

        stripIcon.translatesAutoresizingMaskIntoConstraints = false
        stripIcon.image = KeyboardViewController.makeBrandIcon().withRenderingMode(.alwaysTemplate)
        stripIcon.contentMode = .scaleAspectFit

        stripTrailing.translatesAutoresizingMaskIntoConstraints = false
        stripTrailing.contentMode = .scaleAspectFit

        speakistStrip.addSubview(stripIcon)
        speakistStrip.addSubview(stripLabel)
        speakistStrip.addSubview(stripTrailing)

        NSLayoutConstraint.activate([
            stripIcon.leadingAnchor.constraint(equalTo: speakistStrip.leadingAnchor, constant: 14),
            stripIcon.centerYAnchor.constraint(equalTo: speakistStrip.centerYAnchor),
            stripIcon.widthAnchor.constraint(equalToConstant: 22),
            stripIcon.heightAnchor.constraint(equalToConstant: 22),

            stripTrailing.trailingAnchor.constraint(equalTo: speakistStrip.trailingAnchor, constant: -14),
            stripTrailing.centerYAnchor.constraint(equalTo: speakistStrip.centerYAnchor),
            stripTrailing.widthAnchor.constraint(equalToConstant: 18),
            stripTrailing.heightAnchor.constraint(equalToConstant: 18),

            stripLabel.leadingAnchor.constraint(greaterThanOrEqualTo: stripIcon.trailingAnchor, constant: 8),
            stripLabel.trailingAnchor.constraint(lessThanOrEqualTo: stripTrailing.leadingAnchor, constant: -8),
            stripLabel.centerXAnchor.constraint(equalTo: speakistStrip.centerXAnchor),
            stripLabel.centerYAnchor.constraint(equalTo: speakistStrip.centerYAnchor)
        ])
    }

    private func setupSpeakistContainer() {
        let listeningRow = UIStackView(arrangedSubviews: [cancelButton, waveformView, finishButton])
        listeningRow.axis = .horizontal
        listeningRow.distribution = .fill
        listeningRow.alignment = .center
        listeningRow.spacing = 16
        listeningRow.translatesAutoresizingMaskIntoConstraints = false
        waveformView.setContentHuggingPriority(.defaultLow, for: .horizontal)

        speakistContainer.addSubview(primaryButton)
        speakistContainer.addSubview(listeningRow)
        speakistContainer.addSubview(statusLabel)
        speakistContainer.addSubview(footerLabel)

        NSLayoutConstraint.activate([
            // Primary CTA + listening row share the same slot — only
            // one is visible at a time.
            primaryButton.centerXAnchor.constraint(equalTo: speakistContainer.centerXAnchor),
            primaryButton.topAnchor.constraint(equalTo: speakistContainer.topAnchor, constant: 14),
            primaryButton.heightAnchor.constraint(equalToConstant: 56),
            primaryButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 230),
            primaryButton.leadingAnchor.constraint(greaterThanOrEqualTo: speakistContainer.leadingAnchor, constant: 20),
            primaryButton.trailingAnchor.constraint(lessThanOrEqualTo: speakistContainer.trailingAnchor, constant: -20),

            listeningRow.centerXAnchor.constraint(equalTo: speakistContainer.centerXAnchor),
            listeningRow.topAnchor.constraint(equalTo: speakistContainer.topAnchor, constant: 14),
            listeningRow.heightAnchor.constraint(equalToConstant: 56),
            waveformView.widthAnchor.constraint(equalToConstant: 70),
            waveformView.heightAnchor.constraint(equalToConstant: 40),

            statusLabel.topAnchor.constraint(equalTo: primaryButton.bottomAnchor, constant: 12),
            statusLabel.leadingAnchor.constraint(equalTo: speakistContainer.leadingAnchor, constant: 20),
            statusLabel.trailingAnchor.constraint(equalTo: speakistContainer.trailingAnchor, constant: -20),

            footerLabel.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 6),
            footerLabel.leadingAnchor.constraint(equalTo: speakistContainer.leadingAnchor, constant: 28),
            footerLabel.trailingAnchor.constraint(equalTo: speakistContainer.trailingAnchor, constant: -28)
        ])
    }

    // MARK: - Wiring

    private func wireQwerty() {
        qwerty.onKey = { [weak self] key in self?.handleQwertyKey(key) }
        qwerty.onGlobeReady = { [weak self] btn in
            // Apple's selector on UIInputViewController handles tap
            // (advance) and long-press (input-mode list) in one wire.
            btn.addTarget(self,
                          action: #selector(UIInputViewController.handleInputModeList(from:with:)),
                          for: .allTouchEvents)
        }
    }

    private func wireSpeakistControls() {
        primaryButton.addAction(UIAction { [weak self] _ in self?.tappedPrimary() }, for: .touchUpInside)
        finishButton.addAction(UIAction { [weak self] _ in self?.tappedFinish() }, for: .touchUpInside)
        cancelButton.addAction(UIAction { [weak self] _ in self?.tappedCancel() }, for: .touchUpInside)
    }

    private func wireStripTap() {
        speakistStrip.addAction(UIAction { [weak self] _ in self?.tappedStrip() }, for: .touchUpInside)
    }

    // MARK: - Strip tap

    private func tappedStrip() {
        // No-Full-Access banner: tap is informational; route to the
        // status text so users know what to do.
        guard hasFullAccess else {
            return
        }
        switch displayMode {
        case .typing:
            // Activate Speakist. If the app is hot and a session is
            // already armed, we can skip the relaunch and jump to
            // beginSpeaking optimistically — `reconcileFromSession`
            // will correct us if the read was stale.
            mediumImpact.impactOccurred()
            mediumImpact.prepare()
            beginSpeakistFlow()
        case .startSession, .beginSpeaking, .transient:
            // Bail out of dictation and return to typing. Tear down
            // any in-flight session so the main app doesn't sit on a
            // warm mic while we type.
            lightImpact.impactOccurred()
            lightImpact.prepare()
            DarwinNotifier.post(.keyboardRequestedCancel)
            displayMode = .typing
        case .listening:
            // No-op during recording — user must use ✓ or ✕ to avoid
            // accidental loss of an in-progress dictation.
            break
        }
    }

    /// Branches between hot path (post Darwin → main app starts session
    /// with no app switch) and cold path (open the app via URL, which
    /// kicks the user into the listening overlay so they can swipe back).
    private func beginSpeakistFlow() {
        if appIsHot, let raw = AppGroupBridge.defaults?.string(forKey: AppGroupBridge.Key.sessionStatus),
           let status = SpeakSessionStatus(rawValue: raw),
           status == .activating {
            // Session already armed in the foreground app — fire the
            // begin Darwin and flip to listening optimistically.
            DarwinNotifier.post(.keyboardRequestedActivation)
            displayMode = .listening
            return
        }
        // Cold or warm-but-no-session: write a pending request and
        // open the app.
        let now = Date().timeIntervalSince1970
        AppGroupBridge.defaults?.set(now, forKey: AppGroupBridge.Key.pendingSessionRequestAt)
        AppGroupBridge.defaults?.set(hostBundleID(), forKey: AppGroupBridge.Key.currentHostBundleID)
        let tone = AppGroupBridge.defaults?.string(forKey: AppGroupBridge.Key.tonePreference)
        guard let url = URLSchemeRoute.startSession(hostBundleID: hostBundleID(), tone: tone).url else {
            displayMode = .startSession
            statusLabel.text = "Internal error building URL"
            statusLabel.textColor = .speakistCoral
            return
        }
        // Suppress one reconcile pass so the immediate stale `.idle`
        // read from AppGroupBridge doesn't bounce us back to typing
        // before the main app's transition lands.
        suppressReconcile = true
        suppressReconcileExpiry = Date().addingTimeInterval(6)
        // Optimistically pick a mode based on the current app warmth.
        displayMode = appIsHot ? .beginSpeaking : .startSession
        Logger.shared.info("keyboard: tappedStrip → opening \(url.absoluteString)")
        openContainingApp(url: url)
    }

    // MARK: - Speakist control taps

    private func tappedPrimary() {
        switch displayMode {
        case .startSession:
            mediumImpact.impactOccurred()
            mediumImpact.prepare()
            beginSpeakistFlow()
        case .beginSpeaking:
            heavyImpact.impactOccurred()
            successNotification.notificationOccurred(.success)
            heavyImpact.prepare()
            successNotification.prepare()
            DarwinNotifier.post(.keyboardRequestedActivation)
            displayMode = .listening
        case .typing, .listening, .transient:
            break
        }
    }

    private func tappedFinish() {
        mediumImpact.impactOccurred()
        mediumImpact.prepare()
        displayMode = .transient
        statusLabel.text = "Transcribing…"
        statusLabel.textColor = .secondaryLabel
        DarwinNotifier.post(.keyboardRequestedFinish)
    }

    private func tappedCancel() {
        lightImpact.impactOccurred()
        lightImpact.prepare()
        DarwinNotifier.post(.keyboardRequestedCancel)
        // Return straight to typing so the user can keep going without
        // a "Cancelled" pit-stop.
        displayMode = .typing
    }

    // MARK: - QWERTY taps

    private func handleQwertyKey(_ key: QwertyKey) {
        switch key {
        case .insert(let s):
            textDocumentProxy.insertText(s)
            // One-shot shift drops back to off after a single letter.
            if qwerty.shiftState == .oneShot {
                qwerty.shiftState = .off
            }
        case .backspace:
            textDocumentProxy.deleteBackward()
        case .shift:
            switch qwerty.shiftState {
            case .off:     qwerty.shiftState = .oneShot
            case .oneShot: qwerty.shiftState = .locked
            case .locked:  qwerty.shiftState = .off
            }
        case .space:
            textDocumentProxy.insertText(" ")
        case .enter:
            textDocumentProxy.insertText("\n")
        case .switchLayout(let target):
            qwerty.layout = target
            // Letters layout uses shiftState; numbers/symbols don't.
            if target != .letters {
                // Don't disturb shiftState — preserved for when user
                // returns to letters.
            }
        case .globe:
            // Globe key wires to `handleInputModeList` directly via
            // `onGlobeReady` — should never reach here.
            break
        }
        // Re-evaluate auto-cap after every text mutation.
        updateAutoShift()
    }

    /// Set shift to `.oneShot` when the cursor is at a sentence start
    /// (empty doc, leading whitespace, or after `. ! ?` followed by
    /// whitespace). Caps lock is sticky and never overridden.
    private func updateAutoShift() {
        guard qwerty.layout == .letters else { return }
        guard qwerty.shiftState != .locked else { return }
        let ctx = textDocumentProxy.documentContextBeforeInput ?? ""
        let shouldCap = isSentenceStart(context: ctx)
        let target: ShiftState = shouldCap ? .oneShot : .off
        if qwerty.shiftState != target {
            qwerty.shiftState = target
        }
    }

    private func isSentenceStart(context: String) -> Bool {
        if context.isEmpty { return true }
        // All preceding content is whitespace → still at start.
        if context.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
        // Find the last non-whitespace character — if it's terminal
        // punctuation AND the cursor is on whitespace, the next
        // character is a new sentence.
        guard let lastChar = context.last else { return false }
        if !lastChar.isWhitespace { return false }
        // Walk backwards over whitespace to find the prior glyph.
        for ch in context.reversed() {
            if ch.isWhitespace { continue }
            return ch == "." || ch == "!" || ch == "?"
        }
        return true
    }

    // MARK: - Open containing app (UIScene responder path)

    private func openContainingApp(url: URL) {
        guard hasFullAccess else { return }
        let opened = openViaSceneResponder(url: url)
        Logger.shared.info("keyboard: openViaSceneResponder returned \(opened)")
        if !opened {
            statusLabel.text = "Couldn't open Speakist — open it from your Home screen"
            statusLabel.textColor = .speakistPlum
        }
    }

    private func openViaSceneResponder(url: URL) -> Bool {
        if #available(iOS 18.0, *) {
            let selector = sel_registerName("openURL:options:completionHandler:")
            guard let responder = findResponder(for: selector) else { return false }
            if let app = responder as? UIApplication {
                app.open(url, options: [:], completionHandler: nil)
                return true
            } else if let scene = responder as? UIScene {
                scene.open(url, options: nil, completionHandler: nil)
                return true
            }
            return false
        } else {
            let selector = sel_registerName("openURL:")
            guard let responder = findResponder(for: selector) else { return false }
            responder.perform(selector, with: url)
            return true
        }
    }

    private func findResponder(for selector: Selector) -> UIResponder? {
        var responder: UIResponder? = self
        while let current = responder, !current.responds(to: selector) {
            responder = current.next
        }
        return responder
    }

    // MARK: - Display mode application

    private func applyDisplayMode(animated: Bool) {
        updateStripAppearance()
        let typing = (displayMode == .typing)
        if animated {
            UIView.transition(with: view, duration: 0.18, options: [.beginFromCurrentState, .allowUserInteraction], animations: {
                self.qwerty.isHidden = !typing
                self.speakistContainer.isHidden = typing
            })
        } else {
            qwerty.isHidden = !typing
            speakistContainer.isHidden = typing
        }
        applySpeakistContainerForMode(displayMode)
    }

    private func updateStripAppearance() {
        // No-Full-Access takes precedence — surface the warning
        // unconditionally so the user knows why dictation is unavailable.
        guard hasFullAccess else {
            stripLabel.text = "Allow Full Access for Speakist Keyboard in Settings"
            stripLabel.textColor = .white
            stripIcon.tintColor = .white
            stripTrailing.image = UIImage(systemName: "info.circle.fill")
            stripTrailing.tintColor = .white
            speakistStrip.backgroundColor = .speakistCoral
            speakistStrip.isUserInteractionEnabled = false
            return
        }
        speakistStrip.isUserInteractionEnabled = true

        switch displayMode {
        case .typing:
            stripLabel.text = "Tap to dictate with Speakist"
            stripLabel.textColor = .speakistPlum
            stripIcon.tintColor = .speakistPlum
            stripTrailing.image = UIImage(systemName: "mic.circle.fill")
            stripTrailing.tintColor = .speakistPeach
            speakistStrip.backgroundColor = UIColor.speakistPeach.withAlphaComponent(0.18)
        case .startSession:
            stripLabel.text = "Open Speakist & swipe back"
            stripLabel.textColor = .white
            stripIcon.tintColor = .white
            stripTrailing.image = UIImage(systemName: "xmark.circle.fill")
            stripTrailing.tintColor = .white.withAlphaComponent(0.9)
            speakistStrip.backgroundColor = .speakistPlum
        case .beginSpeaking:
            stripLabel.text = "Ready — tap Begin Speaking"
            stripLabel.textColor = .speakistPlum
            stripIcon.tintColor = .speakistPlum
            stripTrailing.image = UIImage(systemName: "xmark.circle.fill")
            stripTrailing.tintColor = .speakistPlum.withAlphaComponent(0.7)
            speakistStrip.backgroundColor = .speakistPeach
        case .listening:
            stripLabel.text = "Listening — tap ✓ when done"
            stripLabel.textColor = .speakistPlum
            stripIcon.tintColor = .speakistPlum
            // No cancel-via-strip during recording — must use ✕ button
            // to avoid surprise cancellations from miss-taps.
            stripTrailing.image = UIImage(systemName: "waveform")
            stripTrailing.tintColor = .speakistPlum
            speakistStrip.backgroundColor = .speakistPeach
        case .transient:
            stripLabel.text = statusLabel.text ?? "Working…"
            stripLabel.textColor = .white
            stripIcon.tintColor = .white
            stripTrailing.image = UIImage(systemName: "xmark.circle.fill")
            stripTrailing.tintColor = .white.withAlphaComponent(0.9)
            speakistStrip.backgroundColor = .speakistPlum
        }
    }

    private func applySpeakistContainerForMode(_ mode: DisplayMode) {
        switch mode {
        case .typing:
            // Container is hidden — tear down the level poll so we
            // don't hold the display link.
            stopLevelPolling()
            waveformView.stopAnimating()
        case .startSession:
            primaryButton.isHidden = false
            finishButton.isHidden = true
            cancelButton.isHidden = true
            waveformView.isHidden = true
            waveformView.stopAnimating()
            stopLevelPolling()
            footerLabel.isHidden = false
            configurePrimary(title: "Start Speakist",
                             image: KeyboardViewController.makeBrandIcon(),
                             background: .speakistPlum)
            statusLabel.text = "Opening Speakist… swipe back when ready"
            statusLabel.textColor = .speakistPlum
        case .beginSpeaking:
            primaryButton.isHidden = false
            finishButton.isHidden = true
            cancelButton.isHidden = true
            waveformView.isHidden = true
            waveformView.stopAnimating()
            stopLevelPolling()
            footerLabel.isHidden = true
            configurePrimary(title: "Begin Speaking",
                             image: UIImage(systemName: "mic.fill"),
                             background: .speakistPeach)
            statusLabel.text = "Ready — tap Begin Speaking when you're in position"
            statusLabel.textColor = .speakistPeach
        case .listening:
            primaryButton.isHidden = true
            finishButton.isHidden = false
            cancelButton.isHidden = false
            waveformView.isHidden = false
            waveformView.startAnimating()
            startLevelPolling()
            footerLabel.isHidden = true
            statusLabel.text = "Listening — tap ✓ when done"
            statusLabel.textColor = .speakistPeach
        case .transient:
            primaryButton.isHidden = true
            finishButton.isHidden = true
            cancelButton.isHidden = true
            waveformView.isHidden = true
            waveformView.stopAnimating()
            stopLevelPolling()
            footerLabel.isHidden = true
            // statusLabel text was set by caller (Transcribing…, error
            // message, etc.); leave it alone here.
        }
    }

    private func configurePrimary(title: String, image: UIImage?, background: UIColor) {
        var cfg = primaryButton.configuration ?? UIButton.Configuration.filled()
        cfg.image = image
        cfg.baseBackgroundColor = background
        cfg.baseForegroundColor = .white
        cfg.attributedTitle = AttributedString(title, attributes: AttributeContainer([
            .font: UIFont.systemFont(ofSize: 17, weight: .semibold)
        ]))
        primaryButton.configuration = cfg
    }

    // MARK: - Reconcile from session

    /// Map external session state to display mode. Called from
    /// viewWillAppear, textDidChange, and Darwin `appStateChanged`.
    /// Idempotent and cheap.
    private func reconcileFromSession() {
        // One-shot suppression so the activation-strip tap can pin
        // the display mode through the ~6 second app-launch round-
        // trip without a stale .idle reading flipping us back.
        if suppressReconcile {
            if let exp = suppressReconcileExpiry, Date() > exp {
                suppressReconcile = false
                suppressReconcileExpiry = nil
            } else {
                return
            }
        }

        guard hasFullAccess else {
            // No IPC available — degrade to typing-only with the
            // coral banner. Don't try to read sessionStatus.
            if displayMode != .typing { displayMode = .typing }
            updateStripAppearance()
            return
        }

        let raw = AppGroupBridge.defaults?.string(forKey: AppGroupBridge.Key.sessionStatus)
            ?? SpeakSessionStatus.idle.rawValue
        let status = SpeakSessionStatus(rawValue: raw) ?? .idle

        switch status {
        case .idle:
            // No active session externally. Anything that's not
            // typing/startSession should drop back to typing.
            if displayMode != .typing && displayMode != .startSession {
                displayMode = .typing
            }
        case .activating:
            // Session armed (audio session set up, mic warm) but not
            // capturing yet — show begin speaking unless we're already
            // recording.
            if displayMode != .listening { displayMode = .beginSpeaking }
        case .listening:
            displayMode = .listening
        case .transcribing:
            displayMode = .transient
            statusLabel.text = "Transcribing…"
            statusLabel.textColor = .secondaryLabel
        case .done:
            // Final transcript was published; consumeFinalTranscript
            // already inserted the text. Return to typing so the user
            // can keep going.
            displayMode = .typing
        case .error:
            displayMode = .transient
            statusLabel.text = AppGroupBridge.defaults?.string(forKey: AppGroupBridge.Key.lastError) ?? "Something went wrong"
            statusLabel.textColor = .speakistCoral
            // Auto-dismiss the error after a couple seconds so the
            // strip doesn't sit on stale red copy.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.4) { [weak self] in
                guard let self else { return }
                if self.displayMode == .transient { self.displayMode = .typing }
            }
        }
        updateStripAppearance()
    }

    // MARK: - Level polling

    private func startLevelPolling() {
        guard levelPollLink == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(pollLevel))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 20, maximum: 60, preferred: 30)
        link.add(to: .main, forMode: .common)
        levelPollLink = link
    }

    private func stopLevelPolling() {
        levelPollLink?.invalidate()
        levelPollLink = nil
    }

    @objc private func pollLevel() {
        guard let defaults = AppGroupBridge.defaults else { return }
        let stamp = defaults.double(forKey: AppGroupBridge.Key.micLevelAt)
        if stamp == 0 || Date().timeIntervalSince1970 - stamp > 0.25 {
            waveformView.setLevel(0)
            return
        }
        let level = defaults.double(forKey: AppGroupBridge.Key.micLevel)
        waveformView.setLevel(Float(level))
    }

    // MARK: - Shared state helpers

    private func sessionIsLive() -> Bool {
        guard let raw = AppGroupBridge.defaults?.string(forKey: AppGroupBridge.Key.sessionStatus),
              let status = SpeakSessionStatus(rawValue: raw) else {
            return false
        }
        if let exp = AppGroupBridge.defaults?.double(forKey: AppGroupBridge.Key.sessionExpiresAt),
           exp > 0,
           Date(timeIntervalSince1970: exp) < Date() {
            return false
        }
        switch status {
        case .activating, .listening, .transcribing: return true
        case .idle, .done, .error: return false
        }
    }

    private func publishHostBundleID() {
        AppGroupBridge.defaults?.set(hostBundleID(), forKey: AppGroupBridge.Key.currentHostBundleID)
    }

    private func hostBundleID() -> String? {
        // iOS doesn't expose the host app's bundle ID to keyboard
        // extensions. Reserved for future heuristic detection.
        return nil
    }

    // MARK: - Darwin observers

    private func observeAppState() {
        darwinTokens.append(DarwinNotifier.shared.observe(.appPublishedFinal) { [weak self] in
            self?.consumeFinalTranscript()
        })
        darwinTokens.append(DarwinNotifier.shared.observe(.appPublishedPartial) { [weak self] in
            self?.consumePartialTranscript()
        })
        darwinTokens.append(DarwinNotifier.shared.observe(.appStateChanged) { [weak self] in
            self?.suppressReconcile = false
            self?.suppressReconcileExpiry = nil
            self?.reconcileFromSession()
        })
    }

    private func consumeFinalTranscript() {
        guard let defaults = AppGroupBridge.defaults else { return }
        let seq = defaults.integer(forKey: AppGroupBridge.Key.transcriptSequence)
        guard seq > lastAppliedSequence else { return }
        lastAppliedSequence = seq
        guard let text = defaults.string(forKey: AppGroupBridge.Key.finalTranscript),
              !text.isEmpty else { return }
        textDocumentProxy.insertText(text)
        // Always follow the transcript with a space if it doesn't
        // already end with whitespace — saves the user a manual
        // keystroke between consecutive dictations.
        if !(text.last?.isWhitespace ?? false) {
            textDocumentProxy.insertText(" ")
        }
        successNotification.notificationOccurred(.success)
        successNotification.prepare()
        // Drop straight back to typing so the user can keep editing.
        displayMode = .typing
        updateAutoShift()
    }

    private func consumePartialTranscript() {
        // Streaming partials aren't wired yet — final-only path
        // handles delivery via consumeFinalTranscript.
    }

    // MARK: - Brand icon

    /// Small peach-outlined waveform-in-bubble glyph. Matches the Mac
    /// menu-bar icon — single visual anchor users recognize across
    /// platforms. Used by both the strip's leading icon and the
    /// `.startSession` primary button.
    private static func makeBrandIcon() -> UIImage {
        let size = CGSize(width: 22, height: 22)
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { ctx in
            let c = ctx.cgContext
            c.setFillColor(UIColor.white.cgColor)
            let barHeights: [CGFloat] = [8, 14, 18, 14, 8]
            let barWidth: CGFloat = 2.2
            let spacing: CGFloat = 1.4
            let totalWidth = CGFloat(barHeights.count) * barWidth + CGFloat(barHeights.count - 1) * spacing
            var x = (size.width - totalWidth) / 2
            let centerY = size.height / 2
            for h in barHeights {
                let rect = CGRect(x: x, y: centerY - h / 2, width: barWidth, height: h)
                let path = UIBezierPath(roundedRect: rect, cornerRadius: barWidth / 2)
                path.fill()
                x += barWidth + spacing
            }
        }
        return image.withRenderingMode(.alwaysOriginal)
    }
}
