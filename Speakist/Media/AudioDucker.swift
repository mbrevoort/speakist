import Foundation
import CoreAudio

/// How far to lower other audio while dictating. Backed by a preference and
/// surfaced as a segmented control in Settings.
enum AudioDuckLevel: String, CaseIterable, Identifiable {
    case mute        // 0%
    case twoPercent  // 2%
    case fourPercent // 4%

    var id: String { rawValue }

    /// Volume scalar (0...1) to duck to.
    var scalar: Float32 {
        switch self {
        case .mute: return 0
        case .twoPercent: return 0.02
        case .fourPercent: return 0.04
        }
    }

    /// Label for the Settings control.
    var label: String {
        switch self {
        case .mute: return "Mute"
        case .twoPercent: return "2%"
        case .fourPercent: return "4%"
        }
    }
}

/// Lowers the system output volume while a dictation is recording, then
/// restores it — so background audio (music, a video, anything) doesn't
/// compete with the user's voice or bleed into the mic.
///
/// **Why ducking instead of pause/resume.** On current macOS a third-party
/// app can't reliably read media play/pause state: MediaRemote's now-playing
/// read is locked down (returns "nothing playing" even for Apple Music), and
/// CoreAudio can't distinguish playing from paused (apps keep their audio
/// unit "running" either way). A blind pause/resume toggle therefore ends up
/// *starting* media that was already paused. Output volume, by contrast, is
/// reliably readable and settable — so we snapshot it, duck it, and restore
/// the exact value. Idempotent and generic; it never starts or stops
/// playback, only changes loudness.
@MainActor
final class AudioDucker {
    private let preferences: Preferences

    /// The device + per-element volumes captured when we ducked, so we can
    /// restore the exact prior levels. Non-nil only while ducked.
    private var duckedDevice: AudioObjectID?
    private var savedVolumes: [(element: UInt32, volume: Float32)] = []

    init(preferences: Preferences) {
        self.preferences = preferences
    }

    // MARK: - Public API

    /// Called when a recording starts: snapshot the current output volume and
    /// lower it to the configured level. No-op when the feature is off, when
    /// already ducked, or when the volume is already at/below the target
    /// (never raises it).
    func duck() {
        guard preferences.duckAudioDuringDictation, duckedDevice == nil else { return }
        guard let device = defaultOutputDevice() else { return }
        let target = preferences.audioDuckLevel.scalar

        // Discover which channels are settable and read their current levels
        // FIRST — all the HasProperty / IsPropertySettable / read calls happen
        // here, before any volume is changed.
        var saved: [(element: UInt32, volume: Float32)] = []
        for element in volumeElements(device) where isVolumeSettable(device, element) {
            guard let current = readVolume(device, element), current > target else { continue }
            saved.append((element, current))
        }
        guard !saved.isEmpty else { return }

        // Apply all channels *concurrently* so a stereo change lands on both
        // ears at once. Doing them sequentially — even back-to-back — leaves a
        // small IPC gap that's audible as the level walking from one ear to
        // the other, especially on restore.
        applyConcurrently(device, saved.map { (element: $0.element, volume: target) })

        duckedDevice = device
        savedVolumes = saved
        Logger.shared.info("Audio: ducked output volume for dictation (\(preferences.audioDuckLevel.label))")
    }

    /// Called when a recording ends (any path): restore the snapshotted
    /// volume. Idempotent — a no-op if we didn't duck.
    func restore() {
        guard let device = duckedDevice else { return }
        let saved = savedVolumes
        duckedDevice = nil
        savedVolumes = []
        applyConcurrently(device, saved)
        Logger.shared.info("Audio: restored output volume after dictation")
    }

    // MARK: - CoreAudio helpers

    /// Write every channel's volume at once. `concurrentPerform` fires the
    /// per-element writes on separate threads so they reach coreaudiod
    /// together — the only way to keep a multi-channel change simultaneous on
    /// a device with no master volume element. Captures only value types (no
    /// `self`) so it's safe to run off the main actor.
    private func applyConcurrently(_ device: AudioObjectID, _ items: [(element: UInt32, volume: Float32)]) {
        guard !items.isEmpty else { return }
        let elements = items.map { $0.element }
        let volumes = items.map { $0.volume }
        DispatchQueue.concurrentPerform(iterations: items.count) { i in
            AudioDucker.writeVolume(device, elements[i], volumes[i])
        }
    }

    private func defaultOutputDevice() -> AudioObjectID? {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var device = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let system = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &device) == noErr,
              device != 0 else { return nil }
        return device
    }

    /// Which volume elements the device exposes. Some devices publish a single
    /// main element (0); many publish per-channel elements (1, 2) instead.
    private func volumeElements(_ device: AudioObjectID) -> [UInt32] {
        [0, 1, 2].filter { readVolume(device, $0) != nil }
    }

    private func readVolume(_ device: AudioObjectID, _ element: UInt32) -> Float32? {
        var addr = Self.volumeAddress(element)
        guard AudioObjectHasProperty(device, &addr) else { return nil }
        var value: Float32 = 0
        var size = UInt32(MemoryLayout<Float32>.size)
        guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &value) == noErr else {
            return nil
        }
        return value
    }

    private func isVolumeSettable(_ device: AudioObjectID, _ element: UInt32) -> Bool {
        var addr = Self.volumeAddress(element)
        var settable = DarwinBoolean(false)
        return AudioObjectHasProperty(device, &addr)
            && AudioObjectIsPropertySettable(device, &addr, &settable) == noErr
            && settable.boolValue
    }

    private nonisolated static func volumeAddress(_ element: UInt32) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyVolumeScalar,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: element)
    }

    /// Lean write — just `AudioObjectSetPropertyData`, no property checks
    /// (callers verify settability up front). `nonisolated static` so it can
    /// run from `concurrentPerform`'s background threads.
    private nonisolated static func writeVolume(_ device: AudioObjectID, _ element: UInt32, _ value: Float32) {
        var addr = volumeAddress(element)
        var v = value
        _ = AudioObjectSetPropertyData(
            device, &addr, 0, nil, UInt32(MemoryLayout<Float32>.size), &v)
    }
}
