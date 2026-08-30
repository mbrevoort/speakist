import Foundation
import CoreAudio
import AudioToolbox
import Combine

struct AudioInputDevice: Identifiable, Hashable, Sendable {
    let id: AudioDeviceID
    let uid: String
    let name: String
    /// Core Audio's `kAudioDevicePropertyTransportType` (e.g.
    /// `kAudioDeviceTransportTypeBluetooth`, `…BuiltIn`, `…USB`).
    /// Captured at enumeration time so callers don't hit Core Audio
    /// on every check. Zero when the property couldn't be read.
    let transportType: UInt32

    /// True for Bluetooth Classic or BLE. Recording from a Bluetooth
    /// mic forces the headset into HFP/HSP, which collapses its
    /// output from A2DP stereo down to call-grade mono. Used by
    /// `AudioRecorder` to avoid prewarming (and to fully tear down
    /// the HAL after each dictation) on Bluetooth inputs.
    var isBluetooth: Bool {
        transportType == kAudioDeviceTransportTypeBluetooth
            || transportType == kAudioDeviceTransportTypeBluetoothLE
    }
}

struct AudioDeviceSnapshot: Sendable {
    let inputs: [AudioInputDevice]
    let defaultInputID: AudioDeviceID?
}

@MainActor
final class DeviceMonitor: ObservableObject {
    @Published private(set) var inputs: [AudioInputDevice] = []
    /// Becomes true only after Core Audio has returned a usable input-device
    /// snapshot. App startup uses this as the gate for audio prewarming so a
    /// wedged HAL can never pull synchronous audio work back onto the main
    /// thread.
    @Published private(set) var isAudioAvailable = false

    /// Fires when the system's default input or output device changes
    /// (user picked a new device in System Settings, plugged in a USB
    /// headset, BT headphones connected, etc.). `AudioRecorder`
    /// subscribes to invalidate its prewarmed engine — the engine's
    /// `inputNode` is bound to a specific HAL device at prewarm time,
    /// and resuming on a stale device deadlocks inside the HAL
    /// handshake. Coalesced with refresh() so subscribers see the
    /// updated `inputs` list when they react.
    let routingChanged = PassthroughSubject<Void, Never>()

    private var defaultInputID: AudioDeviceID?
    private var started = false
    private let snapshotProvider: @Sendable () -> AudioDeviceSnapshot?
    private let installsListeners: Bool
    nonisolated private let coreAudioQueue = DispatchQueue(
        label: "com.speakist.audio.devices",
        qos: .userInitiated)

    init(
        snapshotProvider: @escaping @Sendable () -> AudioDeviceSnapshot? = { DeviceMonitor.captureSnapshot() },
        installsListeners: Bool = true
    ) {
        self.snapshotProvider = snapshotProvider
        self.installsListeners = installsListeners
    }

    func start() {
        guard !started else { return }
        started = true

        // Core Audio's first property lookup initializes the HAL client and
        // can wait forever if coreaudiod is wedged. Keep both the initial scan
        // and listener registration off the main thread so Speakist can still
        // present its UI and let the user quit normally in that state.
        scheduleRefresh()

        guard installsListeners else { return }
        let notify: @Sendable (Bool) -> Void = { [weak self] routingChanged in
            Task { @MainActor in
                self?.scheduleRefresh(notifyRoutingChange: routingChanged)
            }
        }
        coreAudioQueue.async {
            Self.installListeners(notify: notify)
        }
    }

    func refresh() {
        scheduleRefresh()
    }

    func device(withUID uid: String) -> AudioInputDevice? {
        inputs.first(where: { $0.uid == uid })
    }

    /// The device the recorder will actually pull audio from given the
    /// caller's preferences: the pinned UID when set, otherwise the
    /// current system default. Returns nil only if neither resolves
    /// (no default + nothing pinned).
    func currentInput(preferredUID: String?) -> AudioInputDevice? {
        if let uid = preferredUID, let device = device(withUID: uid) {
            return device
        }
        guard let defaultID = defaultInputID else { return nil }
        return inputs.first(where: { $0.id == defaultID })
    }

    func defaultInputDeviceID() -> AudioDeviceID? {
        defaultInputID
    }

    // MARK: - Background refresh

    private func scheduleRefresh(notifyRoutingChange: Bool = false) {
        let provider = snapshotProvider
        coreAudioQueue.async { [weak self] in
            let snapshot = provider()
            Task { @MainActor in
                self?.apply(snapshot, notifyRoutingChange: notifyRoutingChange)
            }
        }
    }

    private func apply(_ snapshot: AudioDeviceSnapshot?, notifyRoutingChange: Bool) {
        if let snapshot {
            inputs = snapshot.inputs
            defaultInputID = snapshot.defaultInputID
            isAudioAvailable = snapshot.defaultInputID != nil && !snapshot.inputs.isEmpty
        } else {
            inputs = []
            defaultInputID = nil
            isAudioAvailable = false
        }

        if notifyRoutingChange {
            routingChanged.send()
        }
    }

    // MARK: - Enumeration

    nonisolated private static func captureSnapshot() -> AudioDeviceSnapshot? {
        guard let inputs = enumerateInputDevices() else { return nil }
        return AudioDeviceSnapshot(
            inputs: inputs,
            defaultInputID: queryDefaultInputDeviceID())
    }

    nonisolated private static func queryDefaultInputDeviceID() -> AudioDeviceID? {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var deviceID: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &deviceID)
        guard status == noErr else { return nil }
        return deviceID
    }

    nonisolated private static func enumerateInputDevices() -> [AudioInputDevice]? {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else {
            return nil
        }
        let count = Int(size) / MemoryLayout<AudioDeviceID>.size
        var ids = [AudioDeviceID](repeating: 0, count: count)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else {
            return nil
        }

        return ids.compactMap { id -> AudioInputDevice? in
            guard deviceHasInputStreams(id) else { return nil }
            guard let name = deviceProperty(id, selector: kAudioObjectPropertyName),
                  let uid = deviceProperty(id, selector: kAudioDevicePropertyDeviceUID) else { return nil }
            return AudioInputDevice(id: id, uid: uid, name: name, transportType: deviceTransportType(id))
        }
    }

    nonisolated private static func deviceTransportType(_ id: AudioDeviceID) -> UInt32 {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyTransportType,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var transport: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &transport)
        return status == noErr ? transport : 0
    }

    nonisolated private static func deviceHasInputStreams(_ id: AudioDeviceID) -> Bool {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr else { return false }
        return size > 0
    }

    nonisolated private static func deviceProperty(_ id: AudioDeviceID, selector: AudioObjectPropertySelector) -> String? {
        var addr = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var cfString: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &cfString)
        guard status == noErr, let value = cfString?.takeRetainedValue() else { return nil }
        return value as String
    }

    // MARK: - Listener

    nonisolated private static func installListeners(
        notify: @escaping @Sendable (Bool) -> Void
    ) {
        var devicesAddr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &devicesAddr, DispatchQueue.main) { _, _ in
            notify(false)
        }

        // Default-device flips fire here even when the device list
        // didn't change (e.g. the user picks a different mic in
        // System Settings) and also when the list did change
        // (headphones plugged in, BT connected). Both cases must
        // invalidate the recorder's prewarmed engine; the devices
        // listener alone misses the System-Settings case.
        for selector in [kAudioHardwarePropertyDefaultInputDevice,
                         kAudioHardwarePropertyDefaultOutputDevice] {
            var addr = AudioObjectPropertyAddress(
                mSelector: selector,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, DispatchQueue.main) { _, _ in
                notify(true)
            }
        }
    }
}
