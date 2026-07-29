import Foundation
import CoreAudio

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

    /// Very low but not silent, per the desired behavior.
    private let duckLevel: Float32 = 0.035

    /// The device + per-element volumes captured when we ducked, so we can
    /// restore the exact prior levels. Non-nil only while ducked.
    private var duckedDevice: AudioObjectID?
    private var savedVolumes: [(element: UInt32, volume: Float32)] = []

    init(preferences: Preferences) {
        self.preferences = preferences
    }

    // MARK: - Public API

    /// Called when a recording starts: snapshot the current output volume and
    /// lower it. No-op when the feature is off, when already ducked, or when
    /// the volume is already at/below the target (never raises it).
    func duck() {
        guard preferences.duckAudioDuringDictation, duckedDevice == nil else { return }
        guard let device = defaultOutputDevice() else { return }

        var saved: [(element: UInt32, volume: Float32)] = []
        var loweredAnything = false
        for element in volumeElements(device) {
            guard let current = readVolume(device, element) else { continue }
            saved.append((element, current))
            if current > duckLevel, setVolume(device, element, duckLevel) {
                loweredAnything = true
            }
        }
        // Only latch as "ducked" if we actually lowered something — otherwise
        // restore() would have nothing to do and we'd needlessly re-set.
        guard loweredAnything else { return }
        duckedDevice = device
        savedVolumes = saved
        Logger.shared.info("Audio: ducked output volume for dictation")
    }

    /// Called when a recording ends (any path): restore the snapshotted
    /// volume. Idempotent — a no-op if we didn't duck.
    func restore() {
        guard let device = duckedDevice else { return }
        for saved in savedVolumes {
            _ = setVolume(device, saved.element, saved.volume)
        }
        duckedDevice = nil
        savedVolumes = []
        Logger.shared.info("Audio: restored output volume after dictation")
    }

    // MARK: - CoreAudio helpers

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

    private func volumeAddress(_ element: UInt32) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyVolumeScalar,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: element)
    }

    private func readVolume(_ device: AudioObjectID, _ element: UInt32) -> Float32? {
        var addr = volumeAddress(element)
        guard AudioObjectHasProperty(device, &addr) else { return nil }
        var value: Float32 = 0
        var size = UInt32(MemoryLayout<Float32>.size)
        guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &value) == noErr else {
            return nil
        }
        return value
    }

    @discardableResult
    private func setVolume(_ device: AudioObjectID, _ element: UInt32, _ value: Float32) -> Bool {
        var addr = volumeAddress(element)
        var settable = DarwinBoolean(false)
        guard AudioObjectHasProperty(device, &addr),
              AudioObjectIsPropertySettable(device, &addr, &settable) == noErr,
              settable.boolValue else { return false }
        var v = value
        return AudioObjectSetPropertyData(
            device, &addr, 0, nil, UInt32(MemoryLayout<Float32>.size), &v) == noErr
    }
}
