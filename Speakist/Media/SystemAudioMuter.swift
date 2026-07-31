import Foundation
import AudioToolbox
import CoreAudio

/// Mutes every other process's audio while a dictation is recording, then
/// unmutes when it ends — so background audio (music, a video, anything)
/// doesn't compete with the user's voice or bleed into the mic.
///
/// **Why a Core Audio process tap instead of device volume.** The previous
/// implementation (`AudioDucker`) snapshotted and lowered the output
/// device's `kAudioDevicePropertyVolumeScalar`. That breaks on Bluetooth
/// headsets: engaging the headset mic flips the device from A2DP to HFP,
/// which has its own separately-stored (usually louder) volume — so users
/// heard playback get *louder* at the start of a dictation, and the
/// duck/restore writes landed on whichever profile's volume slot happened
/// to be live, sometimes leaving the volume stuck low. A process tap with
/// `.mutedWhenTapped` silences other apps' audio *in the mixer*, upstream
/// of any device, so it behaves identically on Bluetooth, USB DACs, and
/// built-in speakers, and there is no saved state to restore — destroying
/// the tap un-mutes.
///
/// The tap excludes Speakist's own process, so our start/stop cues play at
/// full volume while everything else is silent (the old ducker had to defer
/// ducking 200ms so it wouldn't quiet its own "Tink").
///
/// **Why not pause/resume.** On current macOS a third-party app can't
/// reliably read media play/pause state: MediaRemote's now-playing read is
/// entitlement-locked, and CoreAudio can't distinguish playing from paused.
/// A blind pause/resume toggle ends up *starting* media that was paused.
///
/// **Permission.** Creating a process tap requires the "System Audio
/// Recording Only" TCC grant (macOS prompts on first use, using
/// `NSAudioCaptureUsageDescription`). We never read or persist the tapped
/// samples — the IOProc exists only because a tap mutes reliably while
/// it's being pulled — but the OS classifies the tap as audio capture.
/// If the user declines, mute() logs once and no-ops; dictation works
/// normally without it.
///
/// Requires macOS 14.2 (`AudioHardwareCreateProcessTap`). On 14.0/14.1 the
/// feature silently no-ops.
@MainActor
final class SystemAudioMuter {
    private let preferences: Preferences

    /// Live tap pipeline. Non-nil only while muted. Typed as the
    /// availability-free protocol because `TapEngine` itself is
    /// macOS 14.2+ and stored properties can't carry `#available`.
    private var engine: TapEngineInvalidating?
    /// In-flight deferred unmute (see `unmute()`): waits for a Bluetooth
    /// output to renegotiate HFP → A2DP before releasing the tap. Non-nil
    /// only while that wait is running.
    private var pendingUnmute: Task<Void, Never>?
    /// One-shot flags so a broken environment logs once, not per keypress.
    private var loggedUnsupported = false
    private var loggedFailure = false

    init(preferences: Preferences) {
        self.preferences = preferences
    }

    // MARK: - Public API

    /// Called when a recording starts: mute all other processes' audio.
    /// No-op when the feature is off, when already muted, or when the OS
    /// is too old / permission was declined.
    func mute() {
        guard preferences.muteAudioDuringDictation else { return }
        // A deferred unmute from the previous dictation may still be
        // waiting out the Bluetooth HFP → A2DP renegotiation. Cancel it and
        // keep that tap alive — rapid back-to-back dictations reuse the
        // existing mute instead of tearing down and re-creating.
        if engine != nil {
            pendingUnmute?.cancel()
            pendingUnmute = nil
            return
        }
        guard #available(macOS 14.2, *) else {
            if !loggedUnsupported {
                loggedUnsupported = true
                Logger.shared.warn("Audio mute unavailable: requires macOS 14.2+ (process taps)")
            }
            return
        }
        do {
            engine = try TapEngine()
            Logger.shared.info("Audio: muted other apps' audio for dictation")
        } catch {
            if !loggedFailure {
                loggedFailure = true
                Logger.shared.warn("Audio mute failed (System Audio Recording permission declined, or tap error): \(error.localizedDescription)")
            }
        }
    }

    /// Called when a recording ends (any path): tear the tap down, which
    /// un-mutes. Idempotent — a no-op if we didn't mute (or if a deferred
    /// unmute is already in flight).
    ///
    /// **Bluetooth deferral.** A recording on a Bluetooth mic flips the
    /// headset into HFP; releasing the mic flips it back to A2DP. That
    /// renegotiation is triggered by AudioRecorder's *asynchronous* engine
    /// teardown, so it can land 1–2s AFTER key-release — and it audibly
    /// interrupts whatever is playing (~0.5s dropout while the route
    /// rebuilds). Releasing the tap on a single "route looks healthy"
    /// probe therefore fails ~half the time: music resumes, then the
    /// renegotiation arrives and cuts it out mid-note (users reported
    /// exactly this on/off/on pattern). So when the recording used a
    /// Bluetooth input, `unmute(afterBluetoothInput: true)` holds the mute
    /// through the whole disturbance window: wait until we've *seen* the
    /// churn (call-mode sample rate or a device swap) — or waited long
    /// enough to be confident none is coming — and then require the route
    /// to hold steady before releasing. Hard 6s cap so a stuck
    /// renegotiation can never leave audio muted.
    ///
    /// - Parameter afterBluetoothInput: true when the just-finished
    ///   recording captured from a Bluetooth mic (the only case that
    ///   triggers the HFP flip). Callers read it off `AudioRecorder`.
    func unmute(afterBluetoothInput: Bool = false) {
        guard engine != nil, pendingUnmute == nil else { return }
        guard afterBluetoothInput, Self.defaultOutputIsBluetooth() else {
            releaseTap()
            return
        }
        Logger.shared.info("Audio: holding mute through Bluetooth HFP → A2DP renegotiation")
        pendingUnmute = Task { @MainActor [weak self] in
            let start = ContinuousClock.now
            let totalDeadline = start.advanced(by: Self.unmuteTotalCap)
            // Phase 1 window: how long we wait to *observe* churn before
            // concluding none is coming (the flip-back usually starts
            // within ~2s of the engine teardown).
            let churnDeadline = start.advanced(by: Self.unmuteChurnWindow)
            var sawChurn = false
            var lastDevice = Self.defaultOutputDeviceID()
            var stablePolls = 0
            while ContinuousClock.now < totalDeadline {
                guard let self, !Task.isCancelled else { return }
                let device = Self.defaultOutputDeviceID()
                let deviceChanged = device != lastDevice
                lastDevice = device
                if self.bluetoothOutputStillInCallMode() || deviceChanged {
                    // Renegotiation in progress (or just re-published the
                    // device). Note it and reset the stability counter —
                    // release only after the route settles.
                    sawChurn = true
                    stablePolls = 0
                } else if sawChurn || ContinuousClock.now >= churnDeadline {
                    stablePolls += 1
                    if stablePolls >= Self.unmuteStablePollsRequired { break }
                }
                do {
                    try await Task.sleep(for: Self.unmutePollInterval)
                } catch {
                    return // cancelled — a new dictation took the tap over
                }
            }
            guard let self, !Task.isCancelled else { return }
            self.pendingUnmute = nil
            let held = start.duration(to: ContinuousClock.now)
            let heldMs = held.components.seconds * 1000
                + held.components.attoseconds / 1_000_000_000_000_000
            Logger.shared.info(
                "Audio: releasing mute after \(heldMs)ms (churn \(sawChurn ? "observed" : "not observed"))")
            self.releaseTap()
        }
    }

    // MARK: - Unmute timing knobs
    //
    // Tuned against real headsets; if users still report an on/off/on
    // resume, widen the churn window; if the resume feels sluggish on
    // setups that never renegotiate, shrink it.

    /// How often the deferred unmute re-probes the output route.
    private static let unmutePollInterval: Duration = .milliseconds(150)
    /// Consecutive healthy polls required before release (~600ms steady).
    private static let unmuteStablePollsRequired = 4
    /// How long to wait for churn to *start* before assuming none is
    /// coming. The flip-back is triggered by the recorder's async BT
    /// teardown and typically begins within ~2s of key-release.
    private static let unmuteChurnWindow: Duration = .milliseconds(2500)
    /// Absolute ceiling on the hold — audio can never stay muted longer.
    private static let unmuteTotalCap: Duration = .seconds(6)

    /// Destroy the tap (which un-mutes) immediately.
    private func releaseTap() {
        guard let engine else { return }
        self.engine = nil
        engine.invalidate()
        Logger.shared.info("Audio: unmuted other apps' audio after dictation")
    }

    // MARK: - Bluetooth route probing

    /// True while the default output device is a Bluetooth headset whose
    /// nominal sample rate is call-grade — the signature of HFP. A2DP
    /// restores 44.1/48kHz. Non-Bluetooth outputs always return false, so
    /// wired/built-in setups unmute instantly.
    private func bluetoothOutputStillInCallMode() -> Bool {
        guard let device = Self.defaultOutputDeviceID() else { return false }
        let transport = Self.transportType(of: device)
        let isBluetooth = transport == kAudioDeviceTransportTypeBluetooth
            || transport == kAudioDeviceTransportTypeBluetoothLE
        guard isBluetooth, let rate = Self.nominalSampleRate(of: device) else { return false }
        return rate <= 32_000
    }

    /// True when the current default output device is Bluetooth (Classic
    /// or LE) — the only outputs exposed to HFP renegotiation churn.
    private static func defaultOutputIsBluetooth() -> Bool {
        guard let device = defaultOutputDeviceID() else { return false }
        let transport = transportType(of: device)
        return transport == kAudioDeviceTransportTypeBluetooth
            || transport == kAudioDeviceTransportTypeBluetoothLE
    }

    private static func defaultOutputDeviceID() -> AudioObjectID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var device = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
            device != kAudioObjectUnknown else { return nil }
        return device
    }

    private static func transportType(of device: AudioObjectID) -> UInt32 {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyTransportType,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var transport: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &transport) == noErr else {
            return 0
        }
        return transport
    }

    private static func nominalSampleRate(of device: AudioObjectID) -> Double? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var rate: Float64 = 0
        var size = UInt32(MemoryLayout<Float64>.size)
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &rate) == noErr,
              rate > 0 else { return nil }
        return rate
    }
}

// MARK: - Tap pipeline

/// Availability-free facade over `TapEngine` so `SystemAudioMuter` (which
/// still deploys to macOS 14.0) can hold one as a stored property.
private protocol TapEngineInvalidating: AnyObject {
    func invalidate()
}

/// The Core Audio plumbing for one mute session: a global process tap
/// (every process except our own, `.mutedWhenTapped`) wired into a private
/// aggregate device with a running IOProc. The IOProc discards its buffers
/// — its only job is to keep the tap "tapped" so the mute stays engaged;
/// relying on tap creation alone leaves the mute behavior undefined.
@available(macOS 14.2, *)
private final class TapEngine: TapEngineInvalidating {
    enum TapError: LocalizedError {
        case osStatus(String, OSStatus)
        var errorDescription: String? {
            if case let .osStatus(op, status) = self { return "\(op) failed (\(status))" }
            return nil
        }
    }

    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "speakist.audio-mute-tap")

    init() throws {
        // Our own process object — excluded so Speakist's start/stop cues
        // aren't muted along with everything else.
        let ownProcess = try Self.translatePIDToProcessObject(ProcessInfo.processInfo.processIdentifier)

        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [ownProcess])
        description.name = "Speakist dictation mute"
        description.muteBehavior = .mutedWhenTapped
        // Private: invisible to other audio apps, no HAL notifications.
        description.isPrivate = true

        var newTapID = AudioObjectID(kAudioObjectUnknown)
        var status = AudioHardwareCreateProcessTap(description, &newTapID)
        guard status == noErr, newTapID != kAudioObjectUnknown else {
            throw TapError.osStatus("AudioHardwareCreateProcessTap", status)
        }
        tapID = newTapID

        // Wrap the tap in a private aggregate device so we can run an
        // IOProc against it. No sub-devices — the tap is the only source,
        // and we never render anywhere.
        let aggregateDescription: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Speakist Dictation Mute",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [] as [[String: Any]],
            kAudioAggregateDeviceTapListKey: [
                [
                    kAudioSubTapDriftCompensationKey: true,
                    kAudioSubTapUIDKey: description.uuid.uuidString,
                ]
            ],
        ]
        var newAggregateID = AudioObjectID(kAudioObjectUnknown)
        status = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &newAggregateID)
        guard status == noErr, newAggregateID != kAudioObjectUnknown else {
            let creationStatus = status
            cleanup()
            throw TapError.osStatus("AudioHardwareCreateAggregateDevice", creationStatus)
        }
        aggregateID = newAggregateID

        // Pull-and-discard IOProc: keeps the tap active (and therefore the
        // mute engaged) for the lifetime of the session. The samples are
        // never read, stored, or transmitted.
        status = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, queue) { _, _, _, _, _ in }
        guard status == noErr, let ioProcID else {
            let creationStatus = status
            cleanup()
            throw TapError.osStatus("AudioDeviceCreateIOProcIDWithBlock", creationStatus)
        }

        status = AudioDeviceStart(aggregateID, ioProcID)
        guard status == noErr else {
            let startStatus = status
            cleanup()
            throw TapError.osStatus("AudioDeviceStart", startStatus)
        }
    }

    /// Tear the pipeline down; destroying the tap releases the mute.
    /// Ordering matters: stop the IOProc before destroying the devices.
    func invalidate() {
        cleanup()
    }

    private func cleanup() {
        if let ioProcID, aggregateID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateID, ioProcID)
            AudioDeviceDestroyIOProcID(aggregateID, ioProcID)
        }
        ioProcID = nil
        if aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }

    deinit {
        cleanup()
    }

    private static func translatePIDToProcessObject(_ pid: Int32) throws -> AudioObjectID {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var pidValue = pid
        var processObject = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = withUnsafeMutablePointer(to: &pidValue) { pidPtr in
            AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject), &address,
                UInt32(MemoryLayout<pid_t>.size), pidPtr,
                &size, &processObject)
        }
        guard status == noErr, processObject != kAudioObjectUnknown else {
            throw TapError.osStatus("TranslatePIDToProcessObject", status)
        }
        return processObject
    }
}
