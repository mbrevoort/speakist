import XCTest
@testable import Speakist

/// Opt-in, local-only benchmark over retained Speakist audio. It never writes
/// history or sends audio to a service. Prefix positive paths with `+` and
/// negative-control paths with `-` in the manifest; the ordinary suite skips.
final class ParakeetNameBenchmarkTests: XCTestCase {
    func testExactNameReplacementsAndNegativeControls() async throws {
        let manifestPath = ProcessInfo.processInfo.environment[
            "SPEAKIST_NAME_BENCHMARK_MANIFEST"]
            ?? "/private/tmp/speakist-name-benchmark.txt"
        let manifestURL = URL(fileURLWithPath: manifestPath)
        let manifest = try? String(contentsOf: manifestURL, encoding: .utf8)
        let positives = paths(in: manifest, prefix: "+")
        let negatives = paths(in: manifest, prefix: "-")
        guard !positives.isEmpty else {
            throw XCTSkip("Create /private/tmp/speakist-name-benchmark.txt to run the local audio benchmark")
        }

        let runtime = ParakeetRuntime()
        let rules = [
            ReplaceRule(find: "Breford", replacement: "Brevoort"),
            ReplaceRule(find: "brevort", replacement: "Brevoort"),
            ReplaceRule(find: "prevoort", replacement: "Brevoort"),
            ReplaceRule(find: "Brevort", replacement: "Brevoort"),
            ReplaceRule(find: "Jeannie", replacement: "Jeanie"),
            ReplaceRule(find: "Waltie", replacement: "Walti"),
            ReplaceRule(find: "Walty", replacement: "Walti"),
        ]
        var positiveHits = 0
        var falsePositives = 0
        var positiveDetails: [String] = []
        var negativeDetails: [String] = []

        for url in positives {
            let baseline = try await runtime.transcribe(audioURL: url)
            let corrected = LocalTranscriptCorrections.applyWithCount(
                to: baseline.text,
                rules: rules)
            let hit = corrected.replacementCount > 0
                && ["Brevoort", "Jeanie", "Walti"].contains(where: {
                    corrected.text.localizedCaseInsensitiveContains($0)
                })
            positiveHits += hit ? 1 : 0
            positiveDetails.append(
                "\(url.lastPathComponent): \(baseline.text.debugDescription) -> " +
                "\(corrected.text.debugDescription) [\(corrected.replacementCount)]")
            print(
                "NAME_BENCH positive=\(url.lastPathComponent) " +
                "baseline=\(baseline.text.debugDescription) " +
                "corrected=\(corrected.text.debugDescription) " +
                "replacements=\(corrected.replacementCount) " +
                String(format: "seconds=%.3f", baseline.processingSeconds))
        }

        for url in negatives {
            let baseline = try await runtime.transcribe(audioURL: url)
            let corrected = LocalTranscriptCorrections.applyWithCount(
                to: baseline.text,
                rules: rules)
            let falsePositive = corrected.text != baseline.text
            falsePositives += falsePositive ? 1 : 0
            negativeDetails.append(
                "\(url.lastPathComponent): \(baseline.text.debugDescription) -> " +
                "\(corrected.text.debugDescription) [\(corrected.replacementCount)]")
            print(
                "NAME_BENCH negative=\(url.lastPathComponent) " +
                "baseline=\(baseline.text.debugDescription) " +
                "corrected=\(corrected.text.debugDescription) " +
                "replacements=\(corrected.replacementCount) " +
                String(format: "seconds=%.3f", baseline.processingSeconds))
        }

        print(
            "NAME_BENCH summary positive_hits=\(positiveHits)/\(positives.count) " +
            "false_positives=\(falsePositives)/\(negatives.count)")
        XCTAssertEqual(
            positiveHits,
            positives.count,
            positiveDetails.joined(separator: "\n"))
        XCTAssertEqual(
            falsePositives,
            0,
            negativeDetails.joined(separator: "\n"))
    }

    private func paths(in manifest: String?, prefix: Character) -> [URL] {
        guard let manifest else { return [] }
        return manifest
            .split(whereSeparator: \.isNewline)
            .filter { $0.first == prefix }
            .map { String($0.dropFirst()) }
            .map(URL.init(fileURLWithPath:))
            .filter { FileManager.default.fileExists(atPath: $0.path) }
    }
}
