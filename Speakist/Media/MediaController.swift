import Foundation
import AppKit
import CoreAudio

/// Pauses background media (Spotify, Apple Music, a YouTube tab, etc.) while a
/// dictation recording is in progress, then resumes it when the recording
/// ends — so the user's voice isn't competing with playback and the mic
/// doesn't pick up the audio.
///
/// **How it works (and why).** On macOS 15.4+ the private MediaRemote client
/// API is locked down for unentitled apps, so we don't use it. Instead we:
///
///   1. Synthesize the system **Play/Pause media key** (the same event the
///      physical F8/play key sends). It routes to whatever app currently owns
///      "Now Playing", so it's generic across media apps. Event synthesis via
///      `CGEvent.post` works because Speakist is non-sandboxed and already
///      Accessibility-trusted (for pasting).
///   2. Because the media key is a *toggle*, we only send it when something is
///      actually playing — detected via the public CoreAudio process API
///      (`kAudioProcessPropertyIsRunningOutput`), excluding our own process so
///      our start/stop sounds don't count. We remember that we paused and only
///      resume then, so we never accidentally *start* playback that wasn't on.
///
/// Best-effort by nature: the media key targets the Now Playing app, and a
/// manual play/pause by the user mid-dictation could desync the toggle. That's
/// an acceptable trade for a zero-permission, generic convenience feature.
@MainActor
final class MediaController {
    private let preferences: Preferences

    /// True between a `pauseIfPlaying()` that actually paused and its matching
    /// `resume()`. Ensures we only resume media we ourselves paused.
    private var didPause = false

    init(preferences: Preferences) {
        self.preferences = preferences
    }

    // MARK: - Public API

    /// Called when a recording starts. If the feature is enabled and something
    /// is currently playing audio, pause it and remember that we did.
    func pauseIfPlaying() {
        guard preferences.pauseMediaDuringDictation else { return }
        guard !didPause else { return } // already paused for this recording
        guard isOtherProcessOutputtingAudio() else { return }
        didPause = true
        sendPlayPauseKey()
        Logger.shared.info("Media: paused background playback for dictation")
    }

    /// Called when a recording ends (any path). Resumes only if we paused.
    /// Idempotent — safe to call from every end path.
    func resume() {
        guard didPause else { return }
        didPause = false
        sendPlayPauseKey()
        Logger.shared.info("Media: resumed background playback after dictation")
    }

    // MARK: - Media key synthesis

    /// Post a system Play/Pause media-key press (down then up). `NX_KEYTYPE_PLAY`
    /// is 16; media keys are `NSSystemDefined` events with subtype 8.
    private func sendPlayPauseKey() {
        for down in [true, false] {
            let flags = NSEvent.ModifierFlags(rawValue: down ? 0xA00 : 0xB00)
            let data1 = (kPlayKeyCode << 16) | ((down ? 0xA : 0xB) << 8)
            guard let event = NSEvent.otherEvent(
                with: .systemDefined,
                location: .zero,
                modifierFlags: flags,
                timestamp: 0,
                windowNumber: 0,
                context: nil,
                subtype: 8,
                data1: data1,
                data2: -1
            ) else { continue }
            event.cgEvent?.post(tap: .cghidEventTap)
        }
    }

    /// `NX_KEYTYPE_PLAY` from IOKit/hidsystem/ev_keymap.h.
    private let kPlayKeyCode = 16

    // MARK: - "Is something playing?" detection

    /// Whether any process *other than us* is currently outputting audio.
    /// Prefers the per-process CoreAudio signal (macOS 14.4+); falls back to
    /// the default-output-device "running" flag on older systems or on error.
    private func isOtherProcessOutputtingAudio() -> Bool {
        if #available(macOS 14.4, *) {
            if let byProcess = anyOtherProcessRunningOutput() {
                return byProcess
            }
        }
        return defaultOutputDeviceIsRunning()
    }

    /// Per-process detection. Returns nil if the query fails (→ fall back).
    @available(macOS 14.4, *)
    private func anyOtherProcessRunningOutput() -> Bool? {
        let system = AudioObjectID(kAudioObjectSystemObject)
        var listAddr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)

        var dataSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &listAddr, 0, nil, &dataSize) == noErr,
              dataSize > 0 else { return nil }

        let count = Int(dataSize) / MemoryLayout<AudioObjectID>.size
        var procs = [AudioObjectID](repeating: 0, count: count)
        guard AudioObjectGetPropertyData(system, &listAddr, 0, nil, &dataSize, &procs) == noErr else {
            return nil
        }

        let myPid = ProcessInfo.processInfo.processIdentifier
        for proc in procs {
            if processPID(proc) == myPid { continue }
            if processIsRunningOutput(proc) { return true }
        }
        return false
    }

    @available(macOS 14.4, *)
    private func processPID(_ proc: AudioObjectID) -> pid_t {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyPID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var pid: pid_t = -1
        var size = UInt32(MemoryLayout<pid_t>.size)
        _ = AudioObjectGetPropertyData(proc, &addr, 0, nil, &size, &pid)
        return pid
    }

    @available(macOS 14.4, *)
    private func processIsRunningOutput(_ proc: AudioObjectID) -> Bool {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyIsRunningOutput,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var running: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(proc, &addr, 0, nil, &size, &running) == noErr else {
            return false
        }
        return running != 0
    }

    /// Fallback: is the default output device active in *any* process. Coarser
    /// than the per-process signal (a device can be "running" while idle), but
    /// needs no special API level. Read at recording start, before our own
    /// start sound, so it reflects background media only.
    private func defaultOutputDeviceIsRunning() -> Bool {
        let system = AudioObjectID(kAudioObjectSystemObject)
        var devAddr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var deviceID = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &devAddr, 0, nil, &size, &deviceID) == noErr,
              deviceID != 0 else { return false }

        var runAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var running: UInt32 = 0
        var rsize = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(deviceID, &runAddr, 0, nil, &rsize, &running) == noErr else {
            return false
        }
        return running != 0
    }
}
