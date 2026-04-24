import Foundation
import AVFoundation

/// iOS audio recorder. Captures from the microphone and writes a 16 kHz
/// mono Int16 PCM WAV to disk — the same format the Speakist backend
/// expects at `POST /api/transcribe`, so the server pipeline is reused
/// unchanged from the Mac app.
///
/// Two-layer format pattern (mirrors the Mac `AudioRecorder`):
///
///   * `targetFormat` = 16 kHz mono **Float32**, used for the converter
///     output and the in-memory `AVAudioPCMBuffer`. AVAudioFile's
///     `processingFormat` is always Float32, and `write(from:)` requires
///     the buffer to match that format — passing an Int16 buffer
///     crashes in the audio-toolbox bridge on iOS.
///   * File-settings dict = same 16 kHz mono but **Int16** — that's
///     what lands on disk in the WAV. `AVAudioFile(forWriting: settings:
///     commonFormat:)` handles the Float32→Int16 conversion on write,
///     one frame at a time.
///
/// The recorder must run in the containing app, never the keyboard
/// extension: iOS hard-blocks mic access from any app extension (via
/// `CMSUtility_IsAllowedToStartRecording`) regardless of entitlements.
/// The containing app is allowed to keep the mic live in the background
/// with the `audio` background mode — that's how we stay hot after the
/// user swipes back to the target app.
final class AudioRecorder {
    enum RecorderError: Error {
        case permissionDenied
        case engineStartFailed(String)
        case hardwareUnavailable
        case converterSetupFailed
    }

    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var outputFile: AVAudioFile?
    private let outputURL: URL
    private var levelHandler: ((Float) -> Void)?
    /// Flag flipped by `startCapture()`. The mic tap runs continuously
    /// once the engine is prepared (needed to keep the containing app
    /// alive in the background so it can receive Darwin notifications
    /// from the keyboard), but only writes frames to the output file
    /// when this is `true`. Gives us "mic warm but not recording"
    /// during the `.activating` phase so the user's tap on Begin
    /// Speaking is what actually captures audio.
    private var isCapturing = false

    /// In-memory buffer format. Float32 because AVAudioFile.processingFormat
    /// is always Float32; passing the file an Int16 buffer crashes on iOS.
    private let targetFormat: AVAudioFormat = {
        AVAudioFormat(commonFormat: .pcmFormatFloat32,
                      sampleRate: 16_000,
                      channels: 1,
                      interleaved: false)!
    }()

    /// On-disk format (Int16 LPCM WAV). AVAudioFile bridges the two:
    /// we hand it Float32 buffers, it writes Int16 samples.
    private static let fileSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 16_000,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsNonInterleaved: false
    ]

    init() {
        let fileName = "rec-\(UUID().uuidString).wav"
        self.outputURL = FileManager.default.temporaryDirectory.appendingPathComponent(fileName)
    }

    /// Prepare the mic: install the tap, start the engine, keep audio
    /// flowing (and the process alive in the background) — but do NOT
    /// start writing frames yet. Call `startCapture()` later when the
    /// user has actually signaled they want to speak. Throws if
    /// permission was denied, the hardware is unavailable, or the
    /// engine refuses to start.
    func prepare() throws {
        guard AVAudioApplication.shared.recordPermission == .granted else {
            throw RecorderError.permissionDenied
        }

        let input = engine.inputNode
        let hwFormat = input.outputFormat(forBus: 0)
        guard hwFormat.sampleRate > 0 else {
            throw RecorderError.hardwareUnavailable
        }

        guard let converter = AVAudioConverter(from: hwFormat, to: targetFormat) else {
            throw RecorderError.converterSetupFailed
        }
        self.converter = converter

        self.outputFile = try AVAudioFile(
            forWriting: outputURL,
            settings: Self.fileSettings,
            commonFormat: .pcmFormatFloat32,
            interleaved: false
        )

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: hwFormat) { [weak self] buffer, _ in
            self?.handleTap(buffer: buffer)
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw RecorderError.engineStartFailed(error.localizedDescription)
        }
    }

    /// Begin writing tap frames to the output file. Prerequisite:
    /// `prepare()` was called successfully and the engine is running.
    /// Idempotent — calling twice is a no-op on the second call.
    func startCapture() {
        isCapturing = true
    }

    /// One-shot legacy entry point used by Quick Dictate: prepare +
    /// immediately begin capturing. Keyboard-driven sessions stage
    /// these calls separately so the user retains explicit start
    /// control.
    func start() throws {
        try prepare()
        startCapture()
    }

    /// Stops recording and returns the WAV on disk. Caller owns the
    /// file and is responsible for uploading + deleting afterwards.
    func stop() async throws -> URL {
        isCapturing = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        outputFile = nil    // closes the file on dealloc
        converter = nil
        return outputURL
    }

    /// Tear-down without returning the file. Used when the user cancels
    /// mid-recording — deletes the temp file to keep /tmp tidy.
    func cancel() {
        isCapturing = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        outputFile = nil
        converter = nil
        try? FileManager.default.removeItem(at: outputURL)
    }

    /// RMS level callback for driving the waveform. Values are 0…1
    /// already sqrt-curved so callers render linearly.
    func onLevel(_ handler: @escaping (Float) -> Void) {
        self.levelHandler = handler
    }

    // MARK: - Tap

    private func handleTap(buffer: AVAudioPCMBuffer) {
        // Drop frames until the caller says to start capturing. Engine
        // is still running (keeping the process alive in the
        // background), but no audio lands in the file until then.
        guard isCapturing else { return }
        guard let converter, let outputFile else { return }

        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let outCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat,
                                               frameCapacity: outCapacity) else { return }

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
            Logger.shared.warn("AudioRecorder write failed: \(error.localizedDescription)")
            return
        }

        emitLevel(outBuffer)
    }

    private func emitLevel(_ buffer: AVAudioPCMBuffer) {
        guard let data = buffer.floatChannelData?[0], let handler = levelHandler else { return }
        let count = Int(buffer.frameLength)
        guard count > 0 else { return }

        var sum: Float = 0
        for i in 0..<count {
            let sample = data[i]
            sum += sample * sample
        }
        let rms = sqrt(sum / Float(count))
        // Speech RMS lives in 0.02–0.15; sqrt-curve lifts quiet speech
        // visibly while loud speech still caps near 1.
        let curved = sqrt(min(rms * 4.0, 1.0))
        let clamped = min(max(curved, 0), 1)
        DispatchQueue.main.async { handler(clamped) }
    }
}
