import XCTest
@testable import Speakist

@MainActor
final class SystemAudioMuterTests: XCTestCase {
    func testTapSetupDoesNotBlockMainActor() async {
        let preferences = Preferences()
        let previousValue = preferences.muteAudioDuringDictation
        preferences.muteAudioDuringDictation = true
        defer { preferences.muteAudioDuringDictation = previousValue }

        let setupStarted = expectation(description: "tap setup started")
        let muteFinished = expectation(description: "mute finished")
        let gate = DispatchSemaphore(value: 0)
        let engine = BlockingTapEngine()
        let muter = SystemAudioMuter(
            preferences: preferences,
            engineFactory: {
                setupStarted.fulfill()
                _ = gate.wait(timeout: .now() + 1)
                return engine
            })

        Task { @MainActor in
            await muter.mute()
            muteFinished.fulfill()
        }
        await fulfillment(of: [setupStarted], timeout: 1)

        // Reaching this assertion while the factory is gated proves Core
        // Audio setup is not occupying the main actor.
        XCTAssertEqual(muterTestHeartbeat(), 42)
        gate.signal()
        await fulfillment(of: [muteFinished], timeout: 1)
        muter.unmute(afterBluetoothInput: false)
    }

    func testTapTeardownReturnsBeforeCoreAudioCleanupCompletes() async {
        let preferences = Preferences()
        let previousValue = preferences.muteAudioDuringDictation
        preferences.muteAudioDuringDictation = true
        defer { preferences.muteAudioDuringDictation = previousValue }

        let cleanupStarted = expectation(description: "tap cleanup started")
        let cleanupFinished = expectation(description: "tap cleanup finished")
        let gate = DispatchSemaphore(value: 0)
        let engine = BlockingTapEngine(
            onInvalidate: {
                cleanupStarted.fulfill()
                _ = gate.wait(timeout: .now() + 1)
                cleanupFinished.fulfill()
            })
        let muter = SystemAudioMuter(
            preferences: preferences,
            engineFactory: { engine })

        await muter.mute()
        let startedAt = CFAbsoluteTimeGetCurrent()
        muter.unmute(afterBluetoothInput: false)
        let elapsed = CFAbsoluteTimeGetCurrent() - startedAt

        XCTAssertLessThan(elapsed, 0.1)
        await fulfillment(of: [cleanupStarted], timeout: 1)
        XCTAssertEqual(muterTestHeartbeat(), 42)
        gate.signal()
        await fulfillment(of: [cleanupFinished], timeout: 1)
    }

    func testTapSetupWatchdogFallsBackWithoutWaitingForBlockedHAL() async {
        let preferences = Preferences()
        let previousValue = preferences.muteAudioDuringDictation
        preferences.muteAudioDuringDictation = true
        defer { preferences.muteAudioDuringDictation = previousValue }

        let setupStarted = expectation(description: "tap setup started")
        let gate = DispatchSemaphore(value: 0)
        let engine = BlockingTapEngine()
        let muter = SystemAudioMuter(
            preferences: preferences,
            engineFactory: {
                setupStarted.fulfill()
                _ = gate.wait(timeout: .now() + 1)
                return engine
            },
            operationTimeout: .milliseconds(50))

        let startedAt = CFAbsoluteTimeGetCurrent()
        async let mute: Void = muter.mute()
        await fulfillment(of: [setupStarted], timeout: 1)
        await mute
        let elapsed = CFAbsoluteTimeGetCurrent() - startedAt

        XCTAssertLessThan(elapsed, 0.5)
        XCTAssertEqual(muterTestHeartbeat(), 42)
        gate.signal()
    }

    private func muterTestHeartbeat() -> Int { 42 }
}

private final class BlockingTapEngine: TapEngineInvalidating, @unchecked Sendable {
    private let onInvalidate: @Sendable () -> Void

    init(onInvalidate: @escaping @Sendable () -> Void = {}) {
        self.onInvalidate = onInvalidate
    }

    func invalidate() {
        onInvalidate()
    }
}
