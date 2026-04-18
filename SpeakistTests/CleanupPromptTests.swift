import XCTest
@testable import Speakist

@MainActor
final class CleanupPromptTests: XCTestCase {

    func testDefaultPromptMatchesPreferences() {
        let prefs = Preferences()
        XCTAssertEqual(prefs.cleanupSystemPrompt, Preferences.defaultCleanupPrompt)
    }

    func testRestoreDefaultPrompt() {
        let prefs = Preferences()
        prefs.cleanupSystemPrompt = "something else"
        XCTAssertEqual(prefs.cleanupSystemPrompt, "something else")
        prefs.cleanupSystemPrompt = Preferences.defaultCleanupPrompt
        XCTAssertEqual(prefs.cleanupSystemPrompt, Preferences.defaultCleanupPrompt)
    }
}
