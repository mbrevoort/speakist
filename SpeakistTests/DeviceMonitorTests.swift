import Combine
import CoreAudio
import XCTest
@testable import Speakist

@MainActor
final class DeviceMonitorTests: XCTestCase {
    func testStartReturnsBeforeBlockedCoreAudioScanCompletes() async {
        let scanStarted = expectation(description: "background scan started")
        let audioBecameAvailable = expectation(description: "snapshot applied")
        let gate = DispatchSemaphore(value: 0)
        let snapshot = AudioDeviceSnapshot(
            inputs: [
                AudioInputDevice(
                    id: 42,
                    uid: "test-input",
                    name: "Test Microphone",
                    transportType: kAudioDeviceTransportTypeBuiltIn)
            ],
            defaultInputID: 42)

        let monitor = DeviceMonitor(
            snapshotProvider: {
                scanStarted.fulfill()
                _ = gate.wait(timeout: .now() + 0.5)
                return snapshot
            },
            installsListeners: false)

        var cancellables = Set<AnyCancellable>()
        monitor.$isAudioAvailable
            .filter { $0 }
            .prefix(1)
            .sink { _ in audioBecameAvailable.fulfill() }
            .store(in: &cancellables)

        let startedAt = CFAbsoluteTimeGetCurrent()
        monitor.start()
        let elapsed = CFAbsoluteTimeGetCurrent() - startedAt

        XCTAssertLessThan(elapsed, 0.1)
        XCTAssertFalse(monitor.isAudioAvailable)
        await fulfillment(of: [scanStarted], timeout: 1)

        gate.signal()
        await fulfillment(of: [audioBecameAvailable], timeout: 1)

        XCTAssertEqual(monitor.currentInput(preferredUID: nil)?.uid, "test-input")
        XCTAssertEqual(monitor.defaultInputDeviceID(), 42)
    }
}
