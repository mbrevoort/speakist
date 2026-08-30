import Foundation
import AudioToolbox
import CoreAudio

private enum SystemAudioMuterError: LocalizedError {
    case unsupportedOS

    var errorDescription: String? {
        "System audio muting requires macOS 14.2 or newer."
    }
}

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
    /// Core Audio process-tap creation and destruction can block inside the
    /// HAL when coreaudiod is unhealthy. They must never run on the main
    /// actor. This serial queue also prevents an old tap teardown from racing
    /// a new tap creation during rapid back-to-back dictations.
    private let coreAudioQueue: DispatchQueue
    private let engineFactory: @Sendable () throws -> TapEngineInvalidating
    private let operationTimeout: Duration
    private var creationID: UUID?
    private var creationWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseID: UUID?
    private var wantsMuted = false
    private var disabledForSession = false
    /// In-flight deferred unmute (see `unmute()`): waits for a Bluetooth
    /// output to renegotiate HFP → A2DP before releasing the tap. Non-nil
    /// only while that wait is running.
    private var pendingUnmute: Task<Void, Never>?
    /// One-shot flags so a broken environment logs once, not per keypress.
    private var loggedUnsupported = false
    private var loggedFailure = false

    init(
        preferences: Preferences,
        engineFactory: (@Sendable () throws -> TapEngineInvalidating)? = nil,
        coreAudioQueue: DispatchQueue = DispatchQueue(
            label: "com.speakist.audio-mute-lifecycle",
            qos: .userInitiated),
        operationTimeout: Duration = .seconds(2)
    ) {
        self.preferences = preferences
        self.engineFactory = engineFactory ?? { try Self.makeTapEngine() }
        self.coreAudioQueue = coreAudioQueue
        self.operationTimeout = operationTimeout
    }

    // MARK: - Public API

    /// Called when a recording starts: mute all other processes' audio.
    /// No-op when the feature is off, when already muted, or when the OS
    /// is too old / permission was declined.
    func mute() async {
        guard preferences.muteAudioDuringDictation else { return }
        guard !disabledForSession else { return }
        wantsMuted = true
        // A deferred unmute from the previous dictation may still be
        // waiting out the Bluetooth HFP → A2DP renegotiation. Cancel it and
        // keep that tap alive — rapid back-to-back dictations reuse the
        // existing mute instead of tearing down and re-creating.
        if engine != nil {
            pendingUnmute?.cancel()
            pendingUnmute = nil
            return
        }
        // If a previous tap is still being destroyed, don't overlap another
        // Core Audio graph mutation. Muting is optional; recording is not.
        guard releaseID == nil else { return }
        guard #available(macOS 14.2, *) else {
            if !loggedUnsupported {
                loggedUnsupported = true
                Logger.shared.warn("Audio mute unavailable: requires macOS 14.2+ (process taps)")
            }
            return
        }

        await withCheckedContinuation { continuation in
            creationWaiters.append(continuation)
            if creationID == nil {
                beginCreatingTap()
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
    /// through a fixed route-settle window. We intentionally do not poll the
    /// HAL during that window: route queries are synchronous and can beachball
    /// the app when coreaudiod is unhealthy.
    ///
    /// - Parameter afterBluetoothInput: true when the just-finished
    ///   recording captured from a Bluetooth mic (the only case that
    ///   triggers the HFP flip). Callers pass
    ///   `AudioRecorder.lastInputWasBluetooth`.
    func unmute(afterBluetoothInput: Bool) {
        wantsMuted = false
        guard engine != nil, pendingUnmute == nil else { return }
        guard afterBluetoothInput else {
            releaseTap()
            return
        }
        Logger.shared.info("Audio: holding mute through Bluetooth HFP → A2DP renegotiation")
        pendingUnmute = Task { @MainActor [weak self] in
            // Never poll Core Audio synchronously from the main actor while a
            // Bluetooth route is renegotiating. A fixed hold spans the normal
            // HFP → A2DP churn without giving a wedged HAL another UI-blocking
            // call site. A new dictation cancels this task and reuses the tap.
            do { try await Task.sleep(for: Self.bluetoothUnmuteDelay) }
            catch { return }
            guard let self else { return }
            self.pendingUnmute = nil
            Logger.shared.info("Audio: releasing mute after Bluetooth route-settle delay")
            self.releaseTap()
        }
    }

    // MARK: - Unmute timing knobs
    //
    // Tuned against real headsets; if users still report an on/off/on
    // resume, widen the churn window; if the resume feels sluggish on
    // setups that never renegotiate, shrink it.

    private static let bluetoothUnmuteDelay: Duration = .milliseconds(3200)

    /// Destroy the tap (which un-mutes) immediately.
    private func releaseTap() {
        guard let engine else { return }
        self.engine = nil
        let operationID = UUID()
        releaseID = operationID
        coreAudioQueue.async { [weak self] in
            engine.invalidate()
            Task { @MainActor in
                self?.finishReleasingTap(operationID)
            }
        }
        scheduleReleaseWatchdog(operationID)
    }

    private func beginCreatingTap() {
        let operationID = UUID()
        creationID = operationID
        let factory = engineFactory
        coreAudioQueue.async { [weak self] in
            let result = Result { try factory() }
            Task { @MainActor in
                self?.finishCreatingTap(operationID, result: result)
            }
        }
        scheduleCreationWatchdog(operationID)
    }

    private func finishCreatingTap(
        _ operationID: UUID,
        result: Result<TapEngineInvalidating, Error>
    ) {
        guard creationID == operationID else {
            if case let .success(abandonedEngine) = result {
                coreAudioQueue.async { abandonedEngine.invalidate() }
            }
            return
        }
        creationID = nil

        switch result {
        case let .success(newEngine):
            if wantsMuted && !disabledForSession {
                engine = newEngine
                Logger.shared.info("Audio: muted other apps' audio for dictation")
            } else {
                coreAudioQueue.async { newEngine.invalidate() }
            }
        case let .failure(error):
            if !loggedFailure {
                loggedFailure = true
                Logger.shared.warn("Audio mute failed (System Audio Recording permission declined, or tap error): \(error.localizedDescription)")
            }
        }
        resumeCreationWaiters()
    }

    private func finishReleasingTap(_ operationID: UUID) {
        guard releaseID == operationID else { return }
        releaseID = nil
        Logger.shared.info("Audio: unmuted other apps' audio after dictation")
    }

    private func scheduleCreationWatchdog(_ operationID: UUID) {
        let timeout = operationTimeout
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: timeout)
            guard let self, self.creationID == operationID else { return }
            self.creationID = nil
            self.disabledForSession = true
            self.wantsMuted = false
            Logger.shared.warn("Audio mute setup exceeded the Core Audio timeout; muting is disabled until Speakist restarts")
            self.resumeCreationWaiters()
        }
    }

    private func scheduleReleaseWatchdog(_ operationID: UUID) {
        let timeout = operationTimeout
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: timeout)
            guard let self, self.releaseID == operationID else { return }
            self.disabledForSession = true
            self.wantsMuted = false
            Logger.shared.warn("Audio mute teardown exceeded the Core Audio timeout; muting is disabled until Speakist restarts")
        }
    }

    private func resumeCreationWaiters() {
        let waiters = creationWaiters
        creationWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    nonisolated private static func makeTapEngine() throws -> TapEngineInvalidating {
        guard #available(macOS 14.2, *) else {
            throw SystemAudioMuterError.unsupportedOS
        }
        return try TapEngine()
    }
}

// MARK: - Tap pipeline

/// Availability-free facade over `TapEngine` so `SystemAudioMuter` (which
/// still deploys to macOS 14.0) can hold one as a stored property.
protocol TapEngineInvalidating: AnyObject, Sendable {
    func invalidate()
}

/// The Core Audio plumbing for one mute session: a global process tap
/// (every process except our own, `.mutedWhenTapped`) wired into a private
/// aggregate device with a running IOProc. The IOProc discards its buffers
/// — its only job is to keep the tap "tapped" so the mute stays engaged;
/// relying on tap creation alone leaves the mute behavior undefined.
@available(macOS 14.2, *)
private final class TapEngine: TapEngineInvalidating, @unchecked Sendable {
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
