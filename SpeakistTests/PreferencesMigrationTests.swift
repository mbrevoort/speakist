import XCTest
@testable import Speakist

final class PreferencesMigrationTests: XCTestCase {
    func testFreshInstallDefaultsToParakeet() {
        XCTAssertEqual(
            TranscriptionEngineMigration.valueToPersist(
                storedValue: nil,
                onboardingCompleted: false),
            TranscriptionEngine.parakeet.rawValue)
    }

    func testEstablishedInstallWithoutEngineStaysOnCloud() {
        XCTAssertEqual(
            TranscriptionEngineMigration.valueToPersist(
                storedValue: nil,
                onboardingCompleted: true),
            TranscriptionEngine.cloud.rawValue)
    }

    func testExplicitEngineIsNeverOverwritten() {
        XCTAssertNil(
            TranscriptionEngineMigration.valueToPersist(
                storedValue: TranscriptionEngine.parakeet.rawValue,
                onboardingCompleted: true))
        XCTAssertNil(
            TranscriptionEngineMigration.valueToPersist(
                storedValue: TranscriptionEngine.cloud.rawValue,
                onboardingCompleted: false))
    }
}
