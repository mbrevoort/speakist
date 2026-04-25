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

    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var outputFile: AVAudioFile?
    private var outputURL: URL?
    private var startedAt: CFAbsoluteTime = 0
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

    // MARK: - Public

    @MainActor
    func start() throws {
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
        do {
            try engine.start()
        } catch {
            inputNode.removeTap(onBus: 0)
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
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        let duration = CFAbsoluteTimeGetCurrent() - startedAt
        isRecording = false

        let url = outputURL
        outputFile = nil
        outputURL = nil
        converter = nil

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
