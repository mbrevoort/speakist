import XCTest
@testable import Speakist

final class DiffEngineTests: XCTestCase {

    func testIdenticalProducesNoPairs() {
        let pairs = DiffEngine.corrections(from: "Hello world", to: "Hello world")
        XCTAssertTrue(pairs.isEmpty)
    }

    func testSingleReplacement() {
        let pairs = DiffEngine.corrections(from: "I work at Mytrah today",
                                           to: "I work at Mytra today")
        XCTAssertEqual(pairs.count, 1)
        XCTAssertEqual(pairs.first?.from, "Mytrah")
        XCTAssertEqual(pairs.first?.to, "Mytra")
        XCTAssertTrue(pairs.first?.isProperNounLike ?? false)
    }

    func testPunctuationOnlyChangeDiscarded() {
        let pairs = DiffEngine.corrections(from: "let's go, now",
                                           to: "let's go now")
        XCTAssertTrue(pairs.isEmpty, "Expected no token-level diff when only punctuation differs")
    }

    func testMultiWordReplacement() {
        let pairs = DiffEngine.corrections(from: "my friend Brevort Miatra",
                                           to: "my friend Brevoort Mytra")
        XCTAssertEqual(pairs.count, 1)
        XCTAssertEqual(pairs.first?.from, "Brevort Miatra")
        XCTAssertEqual(pairs.first?.to, "Brevoort Mytra")
    }

    func testProperNounHeuristicCapitalization() {
        XCTAssertTrue(DiffEngine.isProperNounLike("Mytra"))
        XCTAssertTrue(DiffEngine.isProperNounLike("iPhone"))
        XCTAssertTrue(DiffEngine.isProperNounLike("GPT4"))
    }

    func testProperNounHeuristicLowercase() {
        XCTAssertFalse(DiffEngine.isProperNounLike("hello"))
        XCTAssertFalse(DiffEngine.isProperNounLike("running faster"))
    }
}
