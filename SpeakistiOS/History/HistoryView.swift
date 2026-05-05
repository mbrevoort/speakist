import SwiftUI
import UIKit

/// Scrollable list of past dictations, most recent first. Each row shows
/// the source badge (Quick Dictate vs Keyboard), a relative timestamp,
/// the audio length, and the transcript excerpt. Tap a row for the full
/// transcript + one-tap re-copy. Swipe to delete.
struct HistoryView: View {
    @EnvironmentObject private var history: HistoryStore

    var body: some View {
        List {
            if history.entries.isEmpty {
                emptyState
            } else {
                Section {
                    ForEach(history.entries) { entry in
                        NavigationLink {
                            HistoryDetailView(entry: entry)
                        } label: {
                            HistoryRow(entry: entry)
                        }
                    }
                    .onDelete { indexSet in
                        for i in indexSet {
                            history.delete(id: history.entries[i].id)
                        }
                    }
                } footer: {
                    // Reinforce on-device storage at the bottom of the list
                    // too — users who land here without reading the home
                    // screen footer still get the privacy story. iCloud-
                    // sounding terms ("Synced", "All your devices") are
                    // deliberately avoided since none of that's true.
                    Label(
                        "Stored only on this device. Speakist does not upload your dictation history.",
                        systemImage: "lock.shield"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 8)
                }
            }
        }
        .navigationTitle("History")
        .toolbar {
            if !history.entries.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Clear all", role: .destructive) {
                            history.deleteAll()
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "waveform")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)
            Text("No dictations yet")
                .font(.headline)
            Text("Your Quick Dictates and keyboard transcripts will show up here.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            // Same on-device messaging that the populated list shows in
            // its footer — keeps the privacy assurance visible even
            // before the user has any history to look at.
            Label("Stored only on this device", systemImage: "lock.shield")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .listRowBackground(Color.clear)
    }
}

private struct HistoryRow: View {
    let entry: HistoryEntry

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: entry.source.icon)
                .font(.title3)
                .foregroundStyle(.speakistPeach)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text(entry.text)
                    .font(.body)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(entry.source.displayLabel)
                    Text("·")
                    Text(relativeTime(entry.createdAt))
                    if entry.audioSeconds > 0 {
                        Text("·")
                        Text(durationLabel(entry.audioSeconds))
                    }
                    if entry.reportedAt != nil {
                        Text("·")
                        Image(systemName: "flag.fill")
                            .font(.caption2)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private func relativeTime(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private func durationLabel(_ seconds: Double) -> String {
        if seconds < 60 {
            return String(format: "%.1fs", seconds)
        }
        return String(format: "%.1fm", seconds / 60)
    }
}

private struct HistoryDetailView: View {
    let entry: HistoryEntry
    @EnvironmentObject private var history: HistoryStore
    @EnvironmentObject private var account: SpeakistAccountManager
    @State private var editedText: String
    @State private var copied: Bool = false
    @State private var showingReportSheet: Bool = false

    init(entry: HistoryEntry) {
        self.entry = entry
        self._editedText = State(initialValue: entry.text)
    }

    /// The freshest version of the entry from the store, falling back
    /// to the value the row was constructed with. Picks up
    /// `reportedAt` updates that happen while the detail view is on
    /// screen (the Report sheet writes through HistoryStore).
    private var liveEntry: HistoryEntry {
        history.entries.first(where: { $0.id == entry.id }) ?? entry
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 8) {
                    Image(systemName: entry.source.icon)
                        .foregroundStyle(.speakistPeach)
                    Text(entry.source.displayLabel)
                        .font(.subheadline.weight(.medium))
                    Spacer()
                    Text(entry.createdAt.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                TextEditor(text: $editedText)
                    .font(.body)
                    .frame(minHeight: 200)
                    .padding(8)
                    .background(Color(uiColor: .secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                HStack {
                    Button {
                        UIPasteboard.general.string = editedText
                        copied = true
                        // Reset the copied label after a beat so the user
                        // can copy again and get fresh visual feedback.
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
                            copied = false
                        }
                    } label: {
                        Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.clipboard")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.speakistPeach)
                    .animation(.easeInOut(duration: 0.15), value: copied)
                }

                if editedText != entry.text {
                    Button("Save edits") {
                        history.updateText(id: entry.id, newText: editedText)
                    }
                    .buttonStyle(.bordered)
                    .tint(.speakistPlum)
                }

                if let model = entry.providerModel {
                    HStack {
                        Text("Model")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(model)
                            .foregroundStyle(.secondary)
                    }
                    .font(.footnote)
                }
            }
            .padding()
        }
        .navigationTitle("Transcript")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Older history entries (pre-feedback) don't carry a
            // transcriptionClientId; without it /api/feedback can't
            // correlate the report. Hide the button for those rather
            // than presenting a sheet that can't submit.
            if entry.transcriptionClientId != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    if liveEntry.reportedAt != nil {
                        Image(systemName: "flag.fill")
                            .foregroundStyle(.secondary)
                            .accessibilityLabel("Reported")
                    } else {
                        Button {
                            showingReportSheet = true
                        } label: {
                            Image(systemName: "flag")
                        }
                        .accessibilityLabel("Report bad transcription")
                    }
                }
            }
        }
        .sheet(isPresented: $showingReportSheet) {
            if let client = account.apiClient {
                ReportFeedbackView(entry: liveEntry, apiClient: client)
                    .environmentObject(history)
            }
        }
    }
}
