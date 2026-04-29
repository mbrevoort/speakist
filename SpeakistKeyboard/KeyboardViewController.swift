import UIKit

/// Speakist custom keyboard extension.
///
/// ## What ships
///
/// A symbols/numbers/punctuation panel (no letters layout) with a
/// dedicated dictation toolbar — patterned on Wispr Flow. Tapping
/// `ABC` advances the iOS input-mode to whatever keyboard the user
/// previously had selected, so they get full QWERTY + their personal
/// dictionary intact. Tapping `Flow` (or the toolbar's `Start Flow`
/// pill) kicks off Speakist dictation.
///
/// App Review 4.5.5 ("fully functional keyboard") is satisfied because
/// the user can always type any character via the host keyboard —
/// `advanceToNextInputMode()` is the canonical Apple API for that.
///
/// ## Display modes
///
///   * `.typing` — toolbar + symbol keyboard (default).
///   * `.startSession` / `.beginSpeaking` / `.listening` / `.transient`
///     — Speakist controls (primary button + ✓/✕ + waveform). The
///     typing surface is hidden under the controls; the user can
///     return to typing by completing or cancelling the session.
///
/// Modes flip in two directions:
///
///   * Explicit user action: `Flow` / `Start Flow` activates Speakist;
///     ✕ during a non-listening Speakist mode returns to typing (and
///     Darwin-cancels any in-flight session).
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

    // MARK: - Top toolbar (visible during .typing)

    /// Replaces the previous slim peach activation strip. Hosts the
    /// settings icon, tone pulldown, and Start Flow pill — see
    /// `KeyboardToolbarView`. Only the warning-overlay surface is
    /// visible without Full Access.
    private let toolbar = KeyboardToolbarView()

    // MARK: - Typing surface

    private let symbols = SymbolKeyboardView()

    // MARK: - Speakist surface

    /// Container holding the existing Speakist controls (primary CTA,
    /// status label, footer, listening row). Sits in the same frame
    /// as `symbols` and gets toggled visible when `displayMode` is
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
        wireSymbols()
        wireSpeakistControls()
        wireToolbar()
        observeAppState()
        applyDisplayMode(animated: false)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        publishHostBundleID()
        reconcileFromSession()
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
        // updating its document. The return key always renders the
        // curved-arrow glyph regardless of returnKeyType (the design
        // calls for a single recognizable iOS glyph), so this hook
        // exists only to reconcile the Speakist session state.
        reconcileFromSession()
    }

    deinit {
        darwinTokens.forEach(DarwinNotifier.shared.remove)
        levelPollLink?.invalidate()
    }

    // MARK: - Layout

    private func setupLayout() {
        setupSpeakistContainer()

        view.addSubview(toolbar)
        view.addSubview(symbols)
        view.addSubview(speakistContainer)

        NSLayoutConstraint.activate([
            toolbar.topAnchor.constraint(equalTo: view.topAnchor),
            toolbar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            toolbar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            toolbar.heightAnchor.constraint(equalToConstant: 52),

            symbols.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
            symbols.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            symbols.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            symbols.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            speakistContainer.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
            speakistContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            speakistContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            speakistContainer.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
    }

    private func setupSpeakistContainer() {
        // Primary CTA + status/footer labels live in one vertical
        // stack; listening row (✕ / waveform / ✓) lives in its own
        // horizontal stack. Both stacks center inside the container,
        // so the visible content (whichever is unhidden) sits
        // vertically between the rainbow strip and the bottom of
        // the keyboard. Only one stack shows at a time —
        // applySpeakistContainerForMode toggles isHidden on each.
        let primaryStack = UIStackView(arrangedSubviews: [primaryButton, statusLabel, footerLabel])
        primaryStack.axis = .vertical
        primaryStack.alignment = .center
        primaryStack.spacing = 10
        primaryStack.translatesAutoresizingMaskIntoConstraints = false
        // Custom spacing so the footer hugs the status label (a
        // wrapping line of body copy + a small disclaimer) tighter
        // than the gap between the CTA and the status.
        primaryStack.setCustomSpacing(6, after: statusLabel)

        let listeningRow = UIStackView(arrangedSubviews: [cancelButton, waveformView, finishButton])
        listeningRow.axis = .horizontal
        listeningRow.distribution = .fill
        listeningRow.alignment = .center
        listeningRow.spacing = 16
        listeningRow.translatesAutoresizingMaskIntoConstraints = false
        waveformView.setContentHuggingPriority(.defaultLow, for: .horizontal)

        speakistContainer.addSubview(primaryStack)
        speakistContainer.addSubview(listeningRow)

        NSLayoutConstraint.activate([
            primaryStack.centerXAnchor.constraint(equalTo: speakistContainer.centerXAnchor),
            primaryStack.centerYAnchor.constraint(equalTo: speakistContainer.centerYAnchor),
            primaryStack.leadingAnchor.constraint(greaterThanOrEqualTo: speakistContainer.leadingAnchor, constant: 20),
            primaryStack.trailingAnchor.constraint(lessThanOrEqualTo: speakistContainer.trailingAnchor, constant: -20),

            primaryButton.heightAnchor.constraint(equalToConstant: 56),
            primaryButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 230),

            listeningRow.centerXAnchor.constraint(equalTo: speakistContainer.centerXAnchor),
            listeningRow.centerYAnchor.constraint(equalTo: speakistContainer.centerYAnchor),
            listeningRow.heightAnchor.constraint(equalToConstant: 56),
            waveformView.widthAnchor.constraint(equalToConstant: 70),
            waveformView.heightAnchor.constraint(equalToConstant: 40)
        ])
    }

    // MARK: - Wiring

    private func wireSymbols() {
        symbols.onKey = { [weak self] key in self?.handleSymbolKey(key) }
    }

    private func wireSpeakistControls() {
        primaryButton.addAction(UIAction { [weak self] _ in self?.tappedPrimary() }, for: .touchUpInside)
        finishButton.addAction(UIAction { [weak self] _ in self?.tappedFinish() }, for: .touchUpInside)
        cancelButton.addAction(UIAction { [weak self] _ in self?.tappedCancel() }, for: .touchUpInside)
    }

    private func wireToolbar() {
        toolbar.onAction = { [weak self] in self?.tappedToolbarAction() }
        toolbar.onBrandTap = { [weak self] in self?.tappedBrandIcon() }
    }

    /// Brand-icon tap — open the main Speakist app via URL scheme.
    /// No session is started or cancelled; iOS just brings the app
    /// foreground so the user can hit Settings, History, etc. Same
    /// `openContainingApp` plumbing as Start Speakist, which means
    /// this also requires Full Access (the responder-chain walk to
    /// find a scene with `openURL:` only works with that grant).
    private func tappedBrandIcon() {
        guard hasFullAccess else { return }
        lightImpact.impactOccurred()
        lightImpact.prepare()
        guard let url = URLSchemeRoute.openApp.url else { return }
        Logger.shared.info("keyboard: brand icon → opening \(url.absoluteString)")
        openContainingApp(url: url)
    }

    /// Single action callback from the toolbar — what it does depends
    /// on the current display mode. In `.typing` it activates Speakist;
    /// in `.startSession` / `.beginSpeaking` (where the toolbar is
    /// showing "Cancel") it tears down the session and returns to the
    /// typing surface. Listening uses the speakistContainer's ✓/✕,
    /// so the toolbar action is hidden in that mode.
    private func tappedToolbarAction() {
        guard hasFullAccess else { return }
        switch displayMode {
        case .typing:
            mediumImpact.impactOccurred()
            mediumImpact.prepare()
            beginSpeakistFlow()
        case .startSession, .beginSpeaking, .transient:
            lightImpact.impactOccurred()
            lightImpact.prepare()
            DarwinNotifier.post(.keyboardRequestedCancel)
            displayMode = .typing
        case .listening:
            // Listening cancel goes through the in-flow ✕ button so a
            // miss-tap on the toolbar can't drop a recording. The
            // toolbar button is hidden in this mode anyway, but defend
            // in depth in case the mode mapping ever changes.
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
        Logger.shared.info("keyboard: startFlow → opening \(url.absoluteString)")
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

    // MARK: - Symbol keyboard taps

    private func handleSymbolKey(_ key: SymbolKey) {
        switch key {
        case .insert(let s):
            textDocumentProxy.insertText(s)
        case .space:
            // The branded spacebar is functionally identical to a
            // stock spacebar — the "speakist" watermark on its face
            // is purely identification.
            textDocumentProxy.insertText(" ")
        case .backspace:
            textDocumentProxy.deleteBackward()
        case .return:
            textDocumentProxy.insertText("\n")
        case .abc:
            // Hand control back to whatever keyboard the user last
            // had selected — typically the system QWERTY. With no
            // globe key on the bottom row, this is the only way out
            // of Speakist's keyboard surface.
            lightImpact.impactOccurred()
            lightImpact.prepare()
            advanceToNextInputMode()
        }
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
        updateToolbarAppearance()
        let typing = (displayMode == .typing)
        if animated {
            UIView.transition(with: view, duration: 0.18, options: [.beginFromCurrentState, .allowUserInteraction], animations: {
                self.symbols.isHidden = !typing
                self.speakistContainer.isHidden = typing
            })
        } else {
            symbols.isHidden = !typing
            speakistContainer.isHidden = typing
        }
        applySpeakistContainerForMode(displayMode)
    }

    private func updateToolbarAppearance() {
        // No-Full-Access takes precedence — surface the warning over
        // the toolbar unconditionally so the user knows why dictation
        // is unavailable.
        guard hasFullAccess else {
            toolbar.setWarning("Allow Full Access for Speakist Keyboard in Settings")
            toolbar.setMode(.hidden)
            return
        }
        toolbar.setWarning(nil)
        switch displayMode {
        case .typing:
            // Default state — peach "Start Speakist" pill ready to go.
            toolbar.setMode(.typing)
        case .startSession, .beginSpeaking, .transient:
            // The user is mid-flow on the begin-speaking screen; the
            // toolbar offers a Cancel as the explicit bail-out path.
            // Tapping it tears down the session and returns to typing.
            toolbar.setMode(.cancellable)
        case .listening:
            // The speakistContainer's ✓/✕ owns the listening lifecycle —
            // hide the toolbar action so a miss-tap up there can't kill
            // an in-progress recording.
            toolbar.setMode(.hidden)
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
            statusLabel.isHidden = false
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
            statusLabel.isHidden = false
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
            // Hide the status label entirely during listening — it
            // lives in `primaryStack` which is also center-Y in the
            // container, so a visible status label here would overlap
            // the listening row's X / waveform / ✓ buttons. The three
            // listening controls speak for themselves; no caption needed.
            statusLabel.isHidden = true
            footerLabel.isHidden = true
        case .transient:
            primaryButton.isHidden = true
            finishButton.isHidden = true
            cancelButton.isHidden = true
            waveformView.isHidden = true
            waveformView.stopAnimating()
            stopLevelPolling()
            statusLabel.isHidden = false
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
            updateToolbarAppearance()
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
        updateToolbarAppearance()
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
