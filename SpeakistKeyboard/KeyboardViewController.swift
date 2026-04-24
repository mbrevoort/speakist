import UIKit

/// Speakist custom keyboard extension.
///
/// Design constraints (all imposed by iOS):
///
///   * This process can NOT touch the microphone. `AVAudioSession` from
///     an extension hard-fails — forbidden since 2014, regardless of
///     entitlements. All recording happens in the containing app.
///   * It CAN talk to the main Speakist app via the App Group bridge
///     (shared UserDefaults + shared container) once the user has
///     toggled "Allow Full Access" on the keyboard in Settings.
///   * It CAN bring the main app foreground by walking the responder
///     chain to a `UIScene` and calling `openURL:options:completionHandler:`
///     — this is the only URL-open path that works from keyboard
///     extensions on iOS 18/26. `extensionContext.open` has never
///     worked for keyboards (Today-widget-only per Apple DTS), and
///     the deprecated 1-arg `openURL:` selector is force-returned
///     `false` in iOS 18+.
///   * Once a session is live, the main app writes transcripts to
///     shared UserDefaults and fires a Darwin notification. We observe
///     here and call `textDocumentProxy.insertText(_:)` to type it
///     into the app hosting the keyboard.
///
/// UX flow (the phases the keyboard has to represent):
///
///   1. **Cold / idle** — app isn't running, user hasn't used Speakist
///      recently. Primary button: plum "Start Speakist" with our brand
///      icon. Tap opens the app and writes a pending-session request.
///   2. **Activating** — app is open and AVAudioSession is ready, but
///      recording hasn't started yet. Primary button: peach "Begin
///      Speaking" with a mic icon. This gates recording behind an
///      explicit keyboard action instead of surprising the user with
///      an open mic.
///   3. **Listening** — recording is live. Big green ✓ (finish) and
///      coral × (cancel) replace the primary button.
///   4. **Transcribing / done** — status line only; primary button
///      hidden for the moment.
final class KeyboardViewController: UIInputViewController {

    // MARK: - Primary action button

    /// The big top-of-keyboard button. Its title + icon + color change
    /// per phase via `applyPrimaryMode(_:)`.
    private let primaryButton: UIButton = {
        let b = UIButton(type: .system)
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
        b.translatesAutoresizingMaskIntoConstraints = false
        return b
    }()

    private enum PrimaryMode: Equatable {
        /// App is cold or unknown state → tap opens the main app.
        case startSession
        /// App is open, audio session armed → tap starts recording.
        case beginSpeaking
        /// Recording is live — primary button hidden, ✓/× + waveform visible.
        case listening
        /// Transcribing / done — everything hidden except the status.
        case transient
    }

    private var primaryMode: PrimaryMode = .startSession {
        didSet { applyPrimaryMode(primaryMode) }
    }

    // MARK: - Status + footer

    private let statusLabel: UILabel = {
        let l = UILabel()
        l.textAlignment = .center
        l.font = .systemFont(ofSize: 13, weight: .medium)
        l.textColor = .secondaryLabel
        l.numberOfLines = 0
        l.text = "Tap Start Speakist to dictate"
        l.translatesAutoresizingMaskIntoConstraints = false
        return l
    }()

    /// Small grey type below the status line. Explains the iOS
    /// microphone limitation so the two-step flow (open app → come
    /// back → begin speaking) doesn't feel arbitrary.
    private let footerLabel: UILabel = {
        let l = UILabel()
        l.textAlignment = .center
        l.font = .systemFont(ofSize: 11, weight: .regular)
        l.textColor = .tertiaryLabel
        l.numberOfLines = 0
        l.text = "Apple requires Speakist to be open to use the microphone from a keyboard."
        l.translatesAutoresizingMaskIntoConstraints = false
        return l
    }()

    // MARK: - Listening controls (live only during recording)

    /// Animated pulsing waveform shown while the session is in the
    /// `.listening` state. Decorative — no real audio levels cross
    /// the App Group — but gives the user a clear "yes, I'm
    /// listening" signal that pairs with the status label.
    private let waveformView: WaveformView = {
        let v = WaveformView()
        v.translatesAutoresizingMaskIntoConstraints = false
        v.isHidden = true
        return v
    }()

    /// Big green ✓ — only visible during `.listening`.
    private let finishButton: UIButton = {
        let b = UIButton(type: .system)
        var cfg = UIButton.Configuration.filled()
        cfg.image = UIImage(systemName: "checkmark")?
            .withConfiguration(UIImage.SymbolConfiguration(pointSize: 24, weight: .bold))
        cfg.baseBackgroundColor = .speakistSage
        cfg.baseForegroundColor = .white
        cfg.cornerStyle = .capsule
        cfg.contentInsets = NSDirectionalEdgeInsets(top: 16, leading: 30, bottom: 16, trailing: 30)
        b.configuration = cfg
        b.translatesAutoresizingMaskIntoConstraints = false
        b.isHidden = true
        b.accessibilityLabel = "Finish dictation"
        return b
    }()

    private let cancelButton: UIButton = {
        let b = UIButton(type: .system)
        var cfg = UIButton.Configuration.gray()
        cfg.image = UIImage(systemName: "xmark")?
            .withConfiguration(UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold))
        cfg.baseForegroundColor = .speakistCoral
        cfg.cornerStyle = .capsule
        cfg.contentInsets = NSDirectionalEdgeInsets(top: 16, leading: 22, bottom: 16, trailing: 22)
        b.configuration = cfg
        b.translatesAutoresizingMaskIntoConstraints = false
        b.isHidden = true
        b.accessibilityLabel = "Cancel dictation"
        return b
    }()

    // MARK: - Bottom key row

    private let globeButton: UIButton = keyButton(icon: "globe")
    private let spaceButton: UIButton = keyButton(title: "space")
    private let returnButton: UIButton = keyButton(title: "return")
    private let backspaceButton: UIButton = keyButton(icon: "delete.left")

    // MARK: - State

    private var darwinTokens: [UUID] = []
    private var lastAppliedSequence: Int = 0

    /// Polls the App Group UserDefaults for the current mic level and
    /// pumps it into the WaveformView. Runs at the display-link rate
    /// while listening, torn down when the keyboard leaves listening
    /// mode so we're not burning CPU during idle.
    private var levelPollLink: CADisplayLink?

    /// Pre-allocated haptic generators. `UIImpactFeedbackGenerator`
    /// has to be `prepare()`-d before it reliably fires on the first
    /// tap — constructing + calling `impactOccurred()` inline often
    /// fires nothing, which is exactly what was happening for Begin
    /// Speaking in the previous build. Keeping these as properties
    /// and calling `prepare()` in `viewDidAppear` guarantees the
    /// Taptic Engine is warmed up and responsive.
    private let mediumImpact = UIImpactFeedbackGenerator(style: .medium)
    private let heavyImpact = UIImpactFeedbackGenerator(style: .heavy)
    private let lightImpact = UIImpactFeedbackGenerator(style: .light)
    private let successNotification = UINotificationFeedbackGenerator()

    /// App counts as "hot" when it wrote a foreground heartbeat within
    /// ~25 seconds, or when there's a live session. Drives the primary
    /// button's mode: hot → beginSpeaking, cold → startSession.
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
        view.backgroundColor = UIColor.systemGray6
        setupLayout()
        wireActions()
        observeAppState()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        publishHostBundleID()
        refresh()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        refresh()
        // Warm up Taptic Engine so the first tap actually fires. Cold
        // `UIImpactFeedbackGenerator` instances often drop their first
        // `impactOccurred()` call — empirically this was why Begin
        // Speaking taps felt "silent" despite having haptic code.
        mediumImpact.prepare()
        heavyImpact.prepare()
        lightImpact.prepare()
        successNotification.prepare()
    }

    override func textDidChange(_ textInput: UITextInput?) {
        super.textDidChange(textInput)
        refresh()
    }

    deinit {
        darwinTokens.forEach(DarwinNotifier.shared.remove)
        levelPollLink?.invalidate()
    }

    // MARK: - Layout

    private func setupLayout() {
        // Bottom row: Globe | Space | Return | Backspace. Space gets
        // the majority of the width via a lower hugging priority.
        let bottomRow = UIStackView(arrangedSubviews: [globeButton, spaceButton, returnButton, backspaceButton])
        bottomRow.axis = .horizontal
        bottomRow.distribution = .fill
        bottomRow.spacing = 6
        bottomRow.translatesAutoresizingMaskIntoConstraints = false
        globeButton.setContentHuggingPriority(.required, for: .horizontal)
        returnButton.setContentHuggingPriority(.required, for: .horizontal)
        backspaceButton.setContentHuggingPriority(.required, for: .horizontal)
        spaceButton.setContentHuggingPriority(.defaultLow, for: .horizontal)

        // Listening controls row — cancel + waveform + finish. The
        // waveform sits between the buttons so it's the visual
        // centerpiece during recording.
        let listeningRow = UIStackView(arrangedSubviews: [cancelButton, waveformView, finishButton])
        listeningRow.axis = .horizontal
        listeningRow.distribution = .fill
        listeningRow.alignment = .center
        listeningRow.spacing = 16
        listeningRow.translatesAutoresizingMaskIntoConstraints = false
        waveformView.setContentHuggingPriority(.defaultLow, for: .horizontal)

        view.addSubview(primaryButton)
        view.addSubview(listeningRow)
        view.addSubview(statusLabel)
        view.addSubview(footerLabel)
        view.addSubview(bottomRow)

        NSLayoutConstraint.activate([
            // Primary button + listening row share the same slot — one
            // is visible at a time so the key row below is never
            // crowded out.
            primaryButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            primaryButton.topAnchor.constraint(equalTo: view.topAnchor, constant: 14),
            primaryButton.heightAnchor.constraint(equalToConstant: 56),
            primaryButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 230),
            primaryButton.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 20),
            primaryButton.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -20),

            listeningRow.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            listeningRow.topAnchor.constraint(equalTo: view.topAnchor, constant: 14),
            listeningRow.heightAnchor.constraint(equalToConstant: 56),
            waveformView.widthAnchor.constraint(equalToConstant: 70),
            waveformView.heightAnchor.constraint(equalToConstant: 40),

            statusLabel.topAnchor.constraint(equalTo: primaryButton.bottomAnchor, constant: 10),
            statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            statusLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),

            footerLabel.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 6),
            footerLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 28),
            footerLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -28),

            bottomRow.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 6),
            bottomRow.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -6),
            bottomRow.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -6),
            bottomRow.heightAnchor.constraint(equalToConstant: 44),
            bottomRow.topAnchor.constraint(greaterThanOrEqualTo: footerLabel.bottomAnchor, constant: 8),

            globeButton.widthAnchor.constraint(equalToConstant: 44),
            returnButton.widthAnchor.constraint(equalToConstant: 66),
            backspaceButton.widthAnchor.constraint(equalToConstant: 44)
        ])
    }

    // MARK: - Actions

    private func wireActions() {
        primaryButton.addAction(UIAction { [weak self] _ in self?.tappedPrimary() }, for: .touchUpInside)
        globeButton.addTarget(self, action: #selector(handleInputModeList(from:with:)), for: .allTouchEvents)
        spaceButton.addAction(UIAction { [weak self] _ in self?.textDocumentProxy.insertText(" ") }, for: .touchUpInside)
        returnButton.addAction(UIAction { [weak self] _ in self?.textDocumentProxy.insertText("\n") }, for: .touchUpInside)
        backspaceButton.addAction(UIAction { [weak self] _ in self?.textDocumentProxy.deleteBackward() }, for: .touchUpInside)
        finishButton.addAction(UIAction { [weak self] _ in self?.tappedFinish() }, for: .touchUpInside)
        cancelButton.addAction(UIAction { [weak self] _ in self?.tappedCancel() }, for: .touchUpInside)
    }

    private func tappedPrimary() {
        switch primaryMode {
        case .startSession:
            mediumImpact.impactOccurred()
            mediumImpact.prepare()  // re-prepare for the next tap
            startSession()
        case .beginSpeaking:
            // Heavy impact + success-notification combo so the "go"
            // moment has a distinctive pattern that's impossible to
            // miss. Both generators are pre-prepared in viewDidAppear
            // and re-prepared here for the next use.
            heavyImpact.impactOccurred()
            successNotification.notificationOccurred(.success)
            heavyImpact.prepare()
            successNotification.prepare()
            beginSpeaking()
        case .listening, .transient:
            // Primary button isn't visible in these states — this
            // branch only runs if the user somehow taps a hidden
            // button, so no-op is correct.
            break
        }
    }

    /// Cold path: tap Start Speakist → write pending request, try to
    /// open the app, instruct user to switch manually if iOS balks.
    private func startSession() {
        let now = Date().timeIntervalSince1970
        AppGroupBridge.defaults?.set(now, forKey: AppGroupBridge.Key.pendingSessionRequestAt)
        AppGroupBridge.defaults?.set(hostBundleID(), forKey: AppGroupBridge.Key.currentHostBundleID)

        let tone = AppGroupBridge.defaults?.string(forKey: AppGroupBridge.Key.tonePreference)
        guard let url = URLSchemeRoute.startSession(hostBundleID: hostBundleID(), tone: tone).url else {
            setStatus("Internal error building URL", tint: .speakistCoral)
            return
        }
        setStatus("Opening Speakist… swipe back when ready, then tap Begin Speaking", tint: .speakistPlum)
        Logger.shared.info("keyboard: startSession tap, opening \(url.absoluteString)")
        openContainingApp(url: url)
    }

    /// Hot path: app is open and activating — fire Darwin to start
    /// recording. No app switch needed, no programmatic open.
    /// Optimistically flip the UI to listening mode immediately so
    /// the user sees ✓ / × right away; the next `appStateChanged`
    /// Darwin from the main app will reconcile if anything went
    /// wrong.
    private func beginSpeaking() {
        DarwinNotifier.post(.keyboardRequestedActivation)
        primaryMode = .listening
        setStatus("Listening — tap ✓ when done", tint: .speakistPeach)
    }

    private func tappedFinish() {
        mediumImpact.impactOccurred()
        mediumImpact.prepare()
        // Hide ✓/× immediately — the session will reach `.transcribing`
        // a few ms later over Darwin, but reacting now removes the
        // "why is ✓ still there" awkwardness.
        primaryMode = .transient
        setStatus("Transcribing…", tint: .secondaryLabel)
        DarwinNotifier.post(.keyboardRequestedFinish)
    }

    private func tappedCancel() {
        lightImpact.impactOccurred()
        lightImpact.prepare()
        primaryMode = .transient
        setStatus("Cancelled", tint: .secondaryLabel)
        DarwinNotifier.post(.keyboardRequestedCancel)
    }

    // MARK: - Open containing app (UIScene responder path)

    private func openContainingApp(url: URL) {
        guard hasFullAccess else {
            setStatus("Enable Full Access in Settings → General → Keyboard → Speakist", tint: .speakistCoral)
            return
        }
        let opened = openViaSceneResponder(url: url)
        Logger.shared.info("keyboard: openViaSceneResponder returned \(opened)")
        if !opened {
            setStatus("Couldn't open Speakist — open it from your Home screen", tint: .speakistPlum)
        }
    }

    /// Walk the responder chain for a `UIScene` (or `UIApplication`)
    /// that responds to the iOS 18+ 3-arg open selector. This is the
    /// only URL-open path that actually works from keyboard extensions
    /// on current iOS — the documented `extensionContext.open` is
    /// Today-widget-only, and the deprecated 1-arg `openURL:` is
    /// force-returned `false` by iOS 18+.
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

    // MARK: - State-driven refresh

    /// Single entry point that re-reads shared state and updates UI.
    /// Called on viewDidAppear, textDidChange, and Darwin
    /// `appStateChanged`. Keeps UI consistent without needing separate
    /// updaters per surface.
    private func refresh() {
        guard hasFullAccess else {
            primaryMode = .transient
            statusLabel.text = "Enable Full Access in Settings → General → Keyboard → Speakist"
            statusLabel.textColor = .speakistCoral
            footerLabel.isHidden = true
            return
        }
        // Footer is the "why do we open the app first" explainer —
        // only useful when the user is staring at the Start Speakist
        // button and about to be surprised by a context switch. Once
        // the main app is already warm and the keyboard is showing
        // Begin Speaking / ✓ / ×, the text is clutter.
        footerLabel.isHidden = (primaryMode != .startSession)

        let raw = AppGroupBridge.defaults?.string(forKey: AppGroupBridge.Key.sessionStatus) ?? SpeakSessionStatus.idle.rawValue
        let sessionStatus = SpeakSessionStatus(rawValue: raw) ?? .idle

        switch sessionStatus {
        case .idle:
            primaryMode = .startSession
            if appIsHot {
                // App was open recently; user might be quickly
                // re-dictating. Don't discourage tapping.
                statusLabel.text = "Tap Start Speakist to dictate"
            } else {
                statusLabel.text = "Tap Start Speakist to dictate"
            }
            statusLabel.textColor = .secondaryLabel

        case .activating:
            // Session is armed — audio session is set up, mic is
            // waiting. The BEGIN button is the one the user taps to
            // actually start recording.
            primaryMode = .beginSpeaking
            statusLabel.text = "Ready — tap Begin Speaking when you're in position"
            statusLabel.textColor = .speakistPeach

        case .listening:
            primaryMode = .listening
            statusLabel.text = "Listening — tap ✓ when done"
            statusLabel.textColor = .speakistPeach

        case .transcribing:
            primaryMode = .transient
            statusLabel.text = "Transcribing…"
            statusLabel.textColor = .secondaryLabel

        case .done:
            // `.done` is a blink state — the main app auto-resets
            // itself to `.idle` a moment later, at which point the
            // normal `.startSession` UI returns. We render the
            // "Inserted ✓" confirmation here and let the next
            // `appStateChanged` Darwin handle the reset.
            primaryMode = .transient
            statusLabel.text = "Inserted ✓"
            statusLabel.textColor = .speakistSage

        case .error:
            primaryMode = .startSession
            let err = AppGroupBridge.defaults?.string(forKey: AppGroupBridge.Key.lastError)
            statusLabel.text = err ?? "Something went wrong"
            statusLabel.textColor = .speakistCoral
        }
    }

    private func applyPrimaryMode(_ mode: PrimaryMode) {
        // Footer is only shown when the primary button is the cold-
        // start CTA — see `refresh()` for the rationale. Update here
        // too so mode changes that bypass `refresh()` still hide it.
        footerLabel.isHidden = (mode != .startSession)
        switch mode {
        case .startSession:
            primaryButton.isHidden = false
            finishButton.isHidden = true
            cancelButton.isHidden = true
            waveformView.isHidden = true
            waveformView.stopAnimating()
            configurePrimary(title: "Start Speakist",
                             image: KeyboardViewController.makeBrandIcon(),
                             background: .speakistPlum)
        case .beginSpeaking:
            primaryButton.isHidden = false
            finishButton.isHidden = true
            cancelButton.isHidden = true
            waveformView.isHidden = true
            waveformView.stopAnimating()
            configurePrimary(title: "Begin Speaking",
                             image: UIImage(systemName: "mic.fill"),
                             background: .speakistPeach)
        case .listening:
            primaryButton.isHidden = true
            finishButton.isHidden = false
            cancelButton.isHidden = false
            waveformView.isHidden = false
            waveformView.startAnimating()
            startLevelPolling()
        case .transient:
            // Transcribing / done / error — only the status line is
            // visible. Everything else goes away so the user isn't
            // staring at stale controls.
            primaryButton.isHidden = true
            finishButton.isHidden = true
            cancelButton.isHidden = true
            waveformView.isHidden = true
            waveformView.stopAnimating()
            stopLevelPolling()
        }
    }

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
        // If the level hasn't been updated in 250ms the main app is
        // either between frames, suspended, or crashed — either way,
        // feed zero so the waveform decays to the idle baseline
        // instead of holding a stale peak.
        if stamp == 0 || Date().timeIntervalSince1970 - stamp > 0.25 {
            waveformView.setLevel(0)
            return
        }
        let level = defaults.double(forKey: AppGroupBridge.Key.micLevel)
        waveformView.setLevel(Float(level))
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

    /// Tint-aware status setter with a subtle scale pulse so every tap
    /// has a visible confirmation even if the underlying action is
    /// asynchronous or silent (e.g. iOS dropping a URL open).
    private func setStatus(_ text: String, tint: UIColor) {
        statusLabel.text = text
        statusLabel.textColor = tint
        UIView.animate(withDuration: 0.12, animations: {
            self.statusLabel.transform = CGAffineTransform(scaleX: 1.06, y: 1.06)
        }, completion: { _ in
            UIView.animate(withDuration: 0.18) {
                self.statusLabel.transform = .identity
            }
        })
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
        // iOS does not expose the host app's bundle ID to keyboard
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
            self?.refresh()
        })
    }

    private func consumeFinalTranscript() {
        guard let defaults = AppGroupBridge.defaults else { return }
        let seq = defaults.integer(forKey: AppGroupBridge.Key.transcriptSequence)
        guard seq > lastAppliedSequence else { return }
        lastAppliedSequence = seq
        guard let text = defaults.string(forKey: AppGroupBridge.Key.finalTranscript), !text.isEmpty else { return }
        textDocumentProxy.insertText(text)
        // Always follow the transcript with a space — saves the user
        // a manual keystroke between consecutive dictations or when
        // continuing typing inline. Skipped if the transcript already
        // ends with whitespace so we don't double-space.
        if !(text.last?.isWhitespace ?? false) {
            textDocumentProxy.insertText(" ")
        }
        setStatus("Inserted ✓", tint: .speakistSage)
    }

    private func consumePartialTranscript() {
        // Streaming partials not implemented yet — scaffold's
        // consumeFinalTranscript handles the completed transcript.
    }

    // MARK: - Brand icon

    /// Small peach-outlined waveform-in-bubble glyph rendered via
    /// UIGraphics. Matches the Speakist menu-bar icon on macOS — the
    /// single visual anchor users recognize across platforms. Falls
    /// back to `waveform.badge.mic.fill` on unexpected rendering
    /// failures so the button never renders iconless.
    private static func makeBrandIcon() -> UIImage {
        let size = CGSize(width: 22, height: 22)
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { ctx in
            let c = ctx.cgContext
            // White waveform bars (will render against the peach/plum
            // button background).
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

    // MARK: - Key factories

    private static func keyButton(title: String) -> UIButton {
        let b = UIButton(type: .system)
        var cfg = UIButton.Configuration.gray()
        cfg.attributedTitle = AttributedString(title, attributes: AttributeContainer([
            .font: UIFont.systemFont(ofSize: 14, weight: .regular)
        ]))
        cfg.baseForegroundColor = .label
        cfg.cornerStyle = .medium
        b.configuration = cfg
        b.translatesAutoresizingMaskIntoConstraints = false
        return b
    }

    private static func keyButton(icon: String) -> UIButton {
        let b = UIButton(type: .system)
        var cfg = UIButton.Configuration.gray()
        cfg.image = UIImage(systemName: icon)
        cfg.baseForegroundColor = .label
        cfg.cornerStyle = .medium
        b.configuration = cfg
        b.translatesAutoresizingMaskIntoConstraints = false
        return b
    }
}
