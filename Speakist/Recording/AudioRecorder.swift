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
    @Published private(set) var isRecording = false

    private let preferences: Preferences
    private let deviceMonitor: DeviceMonitor

    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var outputFile: AVAudioFile?
    private var outputURL: URL?
    private var startedAt: CFAbsoluteTime = 0

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
        // Speech RMS usually lives in the 0.02–0.15 range.  Apply a sqrt curve
        // so quiet speech lifts the bars visibly and loud speech still caps at 1.
        let curved = sqrt(min(rms * 4.0, 1.0))
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
