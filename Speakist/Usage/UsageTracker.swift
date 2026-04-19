import Foundation
import GRDB
import Combine

struct UsageRow: Identifiable {
    var id: Int64
    var createdAt: Date
    var provider: String
    var model: String
    var audioSeconds: Double?
}

struct UsageRollup {
    var transcriptionCount: Int
    var totalAudioSeconds: Double
}

enum UsageWindow: String, CaseIterable, Identifiable {
    case last7Days
    case last30Days
    case allTime
    var id: String { rawValue }
    var title: String {
        switch self {
        case .last7Days: return "Last 7 days"
        case .last30Days: return "Last 30 days"
        case .allTime: return "All time"
        }
    }
    var cutoff: Date? {
        switch self {
        case .last7Days: return Date().addingTimeInterval(-7 * 86_400)
        case .last30Days: return Date().addingTimeInterval(-30 * 86_400)
        case .allTime: return nil
        }
    }
}

@MainActor
final class UsageTracker: ObservableObject {
    @Published private(set) var lastRefreshAt: Date = .distantPast

    private let historyStore: HistoryStore

    init(historyStore: HistoryStore) {
        self.historyStore = historyStore
    }

    func record(provider: String, model: String, audioSeconds: Double?) {
        guard let dbQueue = historyStore.dbQueueHandle() else { return }
        do {
            try dbQueue.write { db in
                try db.execute(literal: """
                    INSERT INTO usage (created_at, provider, model, audio_seconds, cleanup_input_tokens, cleanup_output_tokens)
                    VALUES (\(Date().timeIntervalSince1970), \(provider), \(model), \(audioSeconds), NULL, NULL)
                """)
            }
            lastRefreshAt = Date()
        } catch {
            Logger.shared.warn("usage record failed: \(error.localizedDescription)")
        }
    }

    func rollup(provider: String, window: UsageWindow) -> UsageRollup {
        guard let dbQueue = historyStore.dbQueueHandle() else {
            return UsageRollup(transcriptionCount: 0, totalAudioSeconds: 0)
        }
        do {
            return try dbQueue.read { db -> UsageRollup in
                let cutoff = window.cutoff?.timeIntervalSince1970 ?? 0
                let row = try Row.fetchOne(db, sql: """
                    SELECT COUNT(*) AS n,
                           COALESCE(SUM(audio_seconds), 0) AS audio
                    FROM usage
                    WHERE provider = ? AND created_at >= ?
                """, arguments: [provider, cutoff])
                return UsageRollup(
                    transcriptionCount: row?["n"] ?? 0,
                    totalAudioSeconds: row?["audio"] ?? 0)
            }
        } catch {
            Logger.shared.warn("usage rollup failed: \(error.localizedDescription)")
            return UsageRollup(transcriptionCount: 0, totalAudioSeconds: 0)
        }
    }

    func cost(for rollup: UsageRollup, model: String, preferences: Preferences) -> Double {
        let minutes = rollup.totalAudioSeconds / 60.0
        switch model {
        case DeepgramModel.nova3.rawValue: return minutes * preferences.rateDeepgramNova3
        case DeepgramModel.nova2.rawValue: return minutes * preferences.rateDeepgramNova2
        default: return minutes * preferences.rateDeepgramNova3
        }
    }
}
