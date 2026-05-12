import Foundation
import AVFoundation
import AudioToolbox
import Combine

enum AudioRecorderError: Error, LocalizedError {
    case engineStartFailed(String)
    case deviceSelectionFailed(String)
    case conversionFailed
    case writeFailed(String)

    var errorDescription: String? {
        switch self {
        case .engineStartFailed(let s): return "Audio engine failed to start: \(s)"
        case .deviceSelectionFailed(let s): return "Couldn't select input device: \(s)"
        case .conversionFailed: return "Audio conversion failed"
        case .writeFailed(let s): return "Couldn't write audio file: \(s)"
        }
    }
}

struct RecordingResult {
    let url: URL
    let durationSeconds: Double
}

/// Records push-to-talk audio to a 16 kHz mono Int16 WAV file.
/// Publishes live RMS levels (0...1) for HUD waveform.
///
/// Not `@MainActor` — the audio tap runs on Core Audio's internal thread
/// and reads `converter` / `outputFile` directly. start/stop mutations
/// always happen on the main thread; the tap is removed synchronously
/// in stop() before the properties are cleared, so there is no race.
final class AudioRecorder: ObservableObject {
    let levels = PassthroughSubject<Float, Never>()
    /// Per-band magnitudes (low → high voice frequency) emitted on
    /// every audio tap callback for the HUD's spectrum visualizer.
    /// Sized to `bandCount` (currently 7); each value is in [0, 1].
    let bandLevels = PassthroughSubject<[Float], Never>()
    @Published private(set) var isRecording = false

    /// Number of frequency bands published per tap. Matches the
    /// HUD's bar count so the controller doesn't need to resample.
    static let bandCount = 7

    private let preferences: Preferences
    private let deviceMonitor: DeviceMonitor

    /// AVAudioEngine instance. `var` (not `let`) so we can replace it
    /// when Core Audio wedges — `engine.start()` can deadlock inside
    /// the HAL handshake when input/output devices are split across
    /// transports (e.g. USB mic + Bluetooth output) and one of them
    /// is mid-transition. The hung call can't be cancelled; the only
    /// recovery is to abandon the old engine instance and create a
    /// fresh one. See `resetAudioStack()`.
    private var engine = AVAudioEngine()
    /// Serial queue for AVAudioEngine state changes that block on the
    /// audio I/O thread (`start`, `pause`). Both take 200–500ms to
    /// drain or set up the HAL chain; running them inline would block
    /// the main runloop and delay the HUD/transcription transition.
    /// The queue is serial so a fast stop→start cycle can't race —
    /// the next start() implicitly waits for the previous stop's
    /// pause() to finish, even though stop() doesn't await it.
    ///
    /// `var` so it can be replaced alongside `engine` in
    /// `resetAudioStack()` — if a hung `engine.start()` is blocking
    /// the queue, queueing more work behind it would also hang. The
    /// orphaned queue lives until the wedged operation eventually
    /// returns (if ever).
    private var engineQueue = AudioRecorder.makeEngineQueue()

    private static func makeEngineQueue() -> DispatchQueue {
        DispatchQueue(label: "com.speakist.audio.engine", qos: .userInitiated)
    }

    /// Marker thrown by `runWithTimeout` when the wrapped operation
    /// doesn't complete in time. Caught in `start()` to trigger an
    /// audio-stack reset rather than reporting a generic engine error.
    private struct AudioStartTimeout: Error {}
    private var converter: AVAudioConverter?
    private var outputFile: AVAudioFile?
    private var outputURL: URL?
    private var startedAt: CFAbsoluteTime = 0
    /// Whether `prewarm()` has already pulled the input HAL up. Used to
    /// skip the redundant prepare on `start()` so a hot press goes
    /// straight to `engine.start()` without re-allocating I/O buffers.
    private var didPrewarm = false
    /// FFT-based analyzer that turns each tap buffer into voice-band
    /// magnitudes. Reused across taps so its preallocated buffers
    /// stay warm; `start()` resets it for a clean ring.
    private var spectrumAnalyzer = SpectrumAnalyzer(fftSize: 512, sampleRate: 16_000)

    private let targetFormat: AVAudioFormat = {
        AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
    }()

    init(preferences: Preferences, deviceMonitor: DeviceMonitor) {
        self.preferences = preferences
        self.deviceMonitor = deviceMonitor
    }

    // MARK: - Prewarm

    /// Pull the audio HAL fully online while the app is idle so the
    /// first shortcut press doesn't pay ~480ms of cold-start latency
    /// inside `engine.start()`.
    ///
    /// **Why a real start/stop and not just `prepare()`:** measurement
    /// showed that `engine.prepare()` allocates AVFoundation-side
    /// buffers in ~1ms but does **not** establish the Core Audio HAL
    /// connection — that only happens when `start()` is invoked for
    /// the first time. Calling `start()` then `stop()` here pays the
    /// HAL handshake cost up front; subsequent `start()` calls reuse
    /// the still-warm audio unit and complete in single-digit
    /// milliseconds.
    ///
    /// **Cost:** the orange microphone indicator flashes for ~50ms at
    /// app launch. Not nothing, but the alternative is ~480ms of
    /// dead-air on every first push-to-talk press, which is
    /// substantially worse UX. Permission is checked first so the OS
    /// mic prompt stays bound to the user's first deliberate action,
    /// not launch.
    ///
    /// **Idempotency:** `didPrewarm` guards against repeat invocations
    /// (e.g. mic permission changing back to granted). The actual
    /// `start()` path on shortcut press still does its full setup —
    /// prewarm just ensures the HAL is hot.
    @MainActor
    func prewarm() {
        guard !didPrewarm else { return }
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { return }

        // Skip prewarm when input is Bluetooth. Starting+pausing the
        // engine on a BT mic locks the device into HFP/HSP for the
        // entire app session: output drops from A2DP stereo
        // (44.1/48 kHz) to compressed 8/16 kHz mono and active noise
        // cancellation disengages on most over-ears. The cost of
        // skipping prewarm is paid only on the first dictation after
        // BT becomes the input (~480 ms HAL handshake); music keeps
        // sounding right while the app sits idle, which is what the
        // user actually notices.
        if isCurrentInputBluetooth() {
            Logger.shared.info("Audio prewarm skipped: input is Bluetooth (preserves A2DP music quality)")
            return
        }

        do {
            try configureInputDevice()
        } catch {
            Logger.shared.warn("Audio prewarm device select failed: \(error.localizedDescription)")
            return
        }

        let format = engine.inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else {
            Logger.shared.warn("Audio prewarm skipped: hardware sample rate is 0")
            return
        }

        engine.prepare()
        let prewarmStart = CFAbsoluteTimeGetCurrent()
        do {
            try engine.start()
        } catch {
            Logger.shared.warn("Audio prewarm engine.start failed: \(error.localizedDescription)")
            return
        }
        // pause() keeps the Core Audio HAL connection alive and the
        // audio unit chain configured — only the I/O is suspended —
        // so a subsequent start() resumes in single-digit ms instead
        // of paying the 400–700ms HAL handshake again. stop() tears
        // the HAL down completely (we measured 469ms on the next
        // start), which defeats the prewarm.
        engine.pause()
        let prewarmMs = (CFAbsoluteTimeGetCurrent() - prewarmStart) * 1000
        didPrewarm = true
        Logger.shared.info(String(format: "Audio prewarmed: hw=%.0fHz ch=%d (start/pause %.0fms)",
                                  format.sampleRate, format.channelCount, prewarmMs))
    }

    // MARK: - Public

    /// Start recording. Synchronous setup runs on the main actor, but
    /// the slow `engine.start()` call (280–560ms even after a recent
    /// prewarm) is dispatched to a background queue so the runloop is
    /// free to render the HUD immediately. The `.preparing` HUD state
    /// covers the window between this method returning and the engine
    /// actually being live.
    ///
    /// `isRecording` flips to `true` only when the engine is fully
    /// started and tap callbacks can fire. Until then, `isRecording`
    /// stays `false` and the `RecordingResult` returned by `stop()`
    /// will be nil — the caller must handle the case where the user
    /// releases the shortcut before the engine came online.
    @MainActor
    func start() async throws {
        guard !isRecording else { return }
        try configureInputDevice()

        let inputNode = engine.inputNode
        let hardwareFormat = inputNode.outputFormat(forBus: 0)
        guard hardwareFormat.sampleRate > 0 else {
            throw AudioRecorderError.engineStartFailed("Hardware sample rate is 0 — microphone unavailable.")
        }

        let url = Self.makeTempURL()
        outputURL = url
        outputFile = try AVAudioFile(
            forWriting: url,
            settings: Self.outputSettings,
            commonFormat: .pcmFormatFloat32,
            interleaved: false)
        converter = AVAudioConverter(from: hardwareFormat, to: targetFormat)

        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: hardwareFormat) { [weak self] buffer, _ in
            self?.handleTap(buffer: buffer)
        }

        engine.prepare()

        // Log device context so the next freeze has forensic data.
        // Core Audio can deadlock inside the HAL handshake when input
        // and output devices live on different transports (USB +
        // Bluetooth is the common offender), and we want to be able
        // to correlate failures with the device configuration in
        // play at the time.
        let inputDevice = deviceMonitor.currentInput(preferredUID: preferences.inputDeviceUID)
        Logger.shared.info(
            "Engine starting: input=\(inputDevice?.name ?? "default") "
            + "transport=\(inputDevice?.transportType ?? 0) "
            + "hwRate=\(hardwareFormat.sampleRate)Hz "
            + "hwCh=\(hardwareFormat.channelCount)"
        )

        // Run engine.start() on the shared engine queue. It blocks
        // for 280–560ms while the Core Audio HAL handshakes; the
        // queue keeps the main runloop free during that window so
        // the HUD's .preparing state can actually paint. Using the
        // serial queue (instead of a fresh Task.detached) also
        // serializes us behind any in-flight pause() from a recent
        // stop() — preventing concurrent state changes on the
        // engine, which AVAudioEngine isn't documented as
        // thread-safe against.
        //
        // Wrapped in a 5-second timeout: AudioOutputUnitStart can
        // deadlock inside the HAL when the input/output devices are
        // mid-transition (BT profile renegotiating, USB device
        // settling, etc.). Without a timeout the await would hang
        // forever and the only recovery is to quit the app. 5s is
        // well above the worst legitimate cold-start (~700ms in the
        // BT-teardown-then-restart case) so this won't fire on
        // healthy paths.
        let engineRef = engine
        let inputNodeRef = inputNode
        let queueRef = engineQueue
        do {
            try await Self.runWithTimeout(seconds: 5) {
                try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                    queueRef.async {
                        do {
                            try engineRef.start()
                            cont.resume()
                        } catch {
                            cont.resume(throwing: error)
                        }
                    }
                }
            }
        } catch {
            // Tap was installed before the failed start — clean it up
            // so the next attempt isn't carrying a dead tap.
            inputNodeRef.removeTap(onBus: 0)
            outputFile = nil
            outputURL = nil
            converter = nil
            if error is AudioStartTimeout {
                Logger.shared.warn(
                    "engine.start() timed out after 5s. Resetting audio stack. "
                    + "Last input=\(inputDevice?.name ?? "?") transport=\(inputDevice?.transportType ?? 0)"
                )
                resetAudioStack()
                throw AudioRecorderError.engineStartFailed(
                    "Audio engine wedged — reset. Press the shortcut again."
                )
            }
            throw AudioRecorderError.engineStartFailed(error.localizedDescription)
        }

        startedAt = CFAbsoluteTimeGetCurrent()
        isRecording = true
        // Fresh analyzer per session — clears the ring so a new
        // recording doesn't inherit the tail of the previous one.
        spectrumAnalyzer = SpectrumAnalyzer(fftSize: 512, sampleRate: 16_000)
        Logger.shared.info("Recording started: hw=\(hardwareFormat.sampleRate)Hz ch=\(hardwareFormat.channelCount) → 16kHz mono")
    }

    @MainActor
    func stop() -> RecordingResult? {
        guard isRecording else { return nil }

        // removeTap is fast (<1ms in measurements) — keep it on main
        // so no more tap callbacks fire after stop() returns. Tap
        // callback writes to outputFile; we want all writes flushed
        // before we drop the AVAudioFile reference below.
        engine.inputNode.removeTap(onBus: 0)

        let duration = CFAbsoluteTimeGetCurrent() - startedAt
        isRecording = false

        let url = outputURL
        outputFile = nil
        outputURL = nil
        converter = nil

        // Drain the audio I/O thread off-main. AVAudioEngine.pause()
        // takes ~220ms to wait through several buffer cycles + a HAL
        // roundtrip; it's the entire stop()-cost budget when run
        // synchronously. Hand it to the serial engine queue so the
        // main runloop is free to flip the HUD into transcribing
        // state and kick off the network call. The next start() also
        // routes through engineQueue, so a fast stop→start cycle
        // implicitly waits for this pause to finish without us
        // needing to await it from main.
        //
        // BT branch: hard-release the engine so Core Audio actually
        // drops the BT device back to A2DP. AudioUnitUninitialize
        // alone is not enough — AVAudioEngine retains other internal
        // references to the input audio unit (notably the I/O
        // thread) that keep the HAL connection alive, and the
        // headset stays in HFP until the entire engine instance is
        // deallocated. The only reliable release is to drop the
        // engine and let ARC dispose its audio units.
        //
        // Approach: swap `engine` (and its serial queue) for fresh
        // instances on main *immediately*, and dispatch the OLD
        // engine's stop+uninit to its old queue. When that dispatch
        // block exits, the captured `engineRef` goes out of scope,
        // the last reference drops, ARC deallocates the engine,
        // AudioComponentInstanceDispose fires on its internal audio
        // unit, and Core Audio finally releases the BT device.
        //
        // Cost: the next press starts on a fresh engine and pays
        // the full ~480ms HAL cold-start — already the accepted
        // trade for BT users (music quality every idle second vs
        // latency once at the start of a dictation).
        let engineRef = engine
        let teardown = isCurrentInputBluetooth()
        if teardown {
            let audioUnit: AudioUnit? = engine.inputNode.audioUnit
            let queueRef = engineQueue
            // Replace immediately so the next press uses a healthy
            // stack — even if the old engine's teardown is still in
            // flight in the background.
            engine = AVAudioEngine()
            engineQueue = AudioRecorder.makeEngineQueue()
            didPrewarm = false
            queueRef.async {
                engineRef.stop()
                if let au = audioUnit {
                    AudioUnitUninitialize(au)
                }
                // engineRef goes out of scope at block exit; ARC
                // disposes the engine and its audio units here.
            }
        } else {
            engineQueue.async {
                engineRef.pause()
            }
        }

        Logger.shared.info("Recording stopped: \(String(format: "%.2f", duration))s")
        guard let url else { return nil }
        return RecordingResult(url: url, durationSeconds: duration)
    }

    @MainActor
    func cancel() {
        if isRecording {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            isRecording = false
        }
        if let url = outputURL {
            try? FileManager.default.removeItem(at: url)
        }
        outputFile = nil
        outputURL = nil
        converter = nil
    }

    // MARK: - Tap

    private func handleTap(buffer: AVAudioPCMBuffer) {
        guard let converter, let outputFile else { return }

        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let outFrameCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outFrameCapacity) else { return }

        var error: NSError?
        var supplied = false
        let status = converter.convert(to: outBuffer, error: &error) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return buffer
        }

        guard status != .error, outBuffer.frameLength > 0 else { return }

        do {
            try outputFile.write(from: outBuffer)
        } catch {
            Logger.shared.warn("Audio write failed: \(error.localizedDescription)")
        }

        let rms = Self.rms(of: outBuffer)
        let subject = levels
        DispatchQueue.main.async {
            subject.send(rms)
        }

        // Spectrum: feed the converted Float32 buffer into the
        // FFT analyzer. It accumulates samples internally and only
        // returns bands once a full FFT window has been collected,
        // so we can call this every tap without worrying about
        // buffer-size mismatches between the hardware (~341 frames
        // at 48→16 kHz) and the FFT length (512).
        if let outChannel = outBuffer.floatChannelData?[0] {
            let bands = spectrumAnalyzer.analyze(
                input: outChannel,
                frameCount: Int(outBuffer.frameLength),
                bandCount: Self.bandCount
            )
            if let bands {
                let bandSubject = bandLevels
                DispatchQueue.main.async {
                    bandSubject.send(bands)
                }
            }
        }
    }

    // MARK: - Helpers

    private static let outputSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 16_000,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsNonInterleaved: false
    ]

    private static func makeTempURL() -> URL {
        // Per-channel temp subdir keeps different builds' in-flight recordings
        // distinct in /tmp, useful when inspecting leftover files.
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(AppIdentity.displayName, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("rec-\(UUID().uuidString).wav")
    }

    private static func rms(of buffer: AVAudioPCMBuffer) -> Float {
        guard let data = buffer.floatChannelData?[0] else { return 0 }
        let n = Int(buffer.frameLength)
        guard n > 0 else { return 0 }
        var sum: Float = 0
        for i in 0..<n {
            let v = data[i]
            sum += v * v
        }
        let rms = sqrt(sum / Float(n))
        // Two-stage curve tuned for HUD sensitivity:
        //   * 6× pre-gain so quiet speech actually shows up — typical
        //     conversational RMS lives around 0.05–0.15, which the
        //     previous 4× gain compressed into the lower-mid bar range.
        //   * pow(0.4) (steeper than sqrt's 0.5) lifts the low end
        //     more aggressively, so a whisper at 0.02 RMS still
        //     pushes bars to ~40% rather than vanishing.
        // Loud speech still saturates at 1.0 cleanly because the
        // pre-gain * cap clamps before the curve.
        let boosted = min(rms * 6.0, 1.0)
        let curved = pow(boosted, 0.4)
        return min(max(curved, 0), 1)
    }

    /// Whether the recorder's current input device is Bluetooth.
    /// See `AudioInputDevice.isBluetooth` for the HFP-vs-A2DP
    /// rationale that drives the prewarm/teardown branches.
    @MainActor
    private func isCurrentInputBluetooth() -> Bool {
        deviceMonitor.currentInput(preferredUID: preferences.inputDeviceUID)?.isBluetooth ?? false
    }

    /// Abandon the current AVAudioEngine + serial queue and create
    /// fresh ones. Used to recover from a wedged `engine.start()` —
    /// when the HAL deadlocks, the hung dispatch block keeps the
    /// queue blocked, so any work we'd dispatch behind it would also
    /// hang. The old instances become zombies that get deallocated
    /// whenever the wedged operation eventually returns (which may
    /// be never, if Core Audio doesn't time out internally — that's
    /// a small memory leak we accept as the price of recovery).
    ///
    /// `didPrewarm` is reset so the *next* press pays the full
    /// cold-start to re-establish the HAL on the fresh engine.
    @MainActor
    private func resetAudioStack() {
        engine = AVAudioEngine()
        engineQueue = Self.makeEngineQueue()
        didPrewarm = false
    }

    /// Race `op` against a sleep. Throws `AudioStartTimeout` if the
    /// sleep wins. Note: cancelling the operation task does **not**
    /// interrupt a blocked Core Audio call inside the dispatched
    /// block — it just stops the `await` from waiting. The caller is
    /// responsible for cleaning up the orphaned operation (we do
    /// this by replacing the engine + queue in `resetAudioStack`).
    private static func runWithTimeout<T: Sendable>(
        seconds: Double,
        _ op: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await op() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw AudioStartTimeout()
            }
            defer { group.cancelAll() }
            guard let result = try await group.next() else {
                throw AudioStartTimeout()
            }
            return result
        }
    }

    @MainActor
    private func configureInputDevice() throws {
        guard let uid = preferences.inputDeviceUID,
              let device = deviceMonitor.device(withUID: uid) else { return }
        guard let audioUnit = engine.inputNode.audioUnit else {
            throw AudioRecorderError.deviceSelectionFailed("Input audio unit unavailable.")
        }
        var deviceID = device.id
        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &deviceID,
            UInt32(MemoryLayout<AudioDeviceID>.size))
        if status != noErr {
            throw AudioRecorderError.deviceSelectionFailed("OSStatus \(status)")
        }
    }
}
