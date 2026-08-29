import XCTest
@testable import Speakist

final class PreferencesMigrationTests: XCTestCase {
    func testFreshInstallNeedsLocalOnlyOnboarding() {
        XCTAssertTrue(
            LocalOnlySetupMigration.needsOnboarding(completedVersion: 0))
    }

    func testLegacyInstallNeedsLocalOnlyOnboardingRegardlessOfOldEngine() {
        // Stored engine values are intentionally not consulted. A legacy Cloud
        // preference cannot select a network route in the current app.
        XCTAssertTrue(
            LocalOnlySetupMigration.needsOnboarding(completedVersion: 0))
    }

    func testCompletedLocalOnlyOnboardingDoesNotRepeat() {
        XCTAssertFalse(LocalOnlySetupMigration.needsOnboarding(
            completedVersion: LocalOnlySetupMigration.requiredVersion))
    }
}
