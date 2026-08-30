import Foundation
import XCTest
@testable import Speakist

final class SpeakistInstanceLockTests: XCTestCase {
    func testOnlyOneChannelCanHoldSharedLock() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let lockURL = directory.appendingPathComponent("active.lock")
        defer { try? FileManager.default.removeItem(at: directory) }

        let stable = SpeakistInstanceLock.Owner(
            processID: 101,
            bundleID: "com.brevoort-studio.speakist",
            displayName: "Speakist",
            version: "1.0.1")
        let local = SpeakistInstanceLock.Owner(
            processID: 202,
            bundleID: "com.brevoort-studio.speakist.local",
            displayName: "Speakist Local",
            version: "1.0.1")

        let first = try SpeakistInstanceLock(lockURL: lockURL, owner: stable)
        XCTAssertThrowsError(try SpeakistInstanceLock(lockURL: lockURL, owner: local)) { error in
            guard case let SpeakistInstanceLock.LockError.alreadyRunning(owner) = error else {
                return XCTFail("Expected an already-running error, got \(error)")
            }
            XCTAssertEqual(owner, stable)
        }

        first.release()
        let second = try SpeakistInstanceLock(lockURL: lockURL, owner: local)
        second.release()
    }
}
