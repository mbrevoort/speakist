import SwiftUI
import AppKit
import AVFoundation

/// The history pane is now embedded directly in `MainView` (sidebar
/// section). The previous standalone window controller was removed
/// when Speakist consolidated all surfaces into a single main
/// window.
struct HistoryView: View {
    @EnvironmentObject var env: AppEnvironment
    @EnvironmentObject var history: HistoryStore
    @State private var search = ""
    @State private var filter: HistoryFilter = .all
    @State private var selection: String?

    var body: some View {
        // `HSplitView` (not `NavigationSplitView`) so the History pane
        // composes cleanly inside `MainView`'s outer
        // `NavigationSplitView`. Nesting two `NavigationSplitView`s on
        // macOS renders two sidebars side-by-side, which doesn't match
        // the unified single-window layout we want.
        //
        // Sidebar widths are deliberately modest (260 ideal, 220 min)
        // so the detail column has room to breathe when the outer
        // workspace sidebar is also visible — otherwise the detail
        // gets squeezed into a narrow strip on the right.
        HSplitView {
            sidebar
                .frame(minWidth: 220, idealWidth: 260, maxWidth: 340,
                       maxHeight: .infinity)
            detail
                .frame(minWidth: 280, maxWidth: .infinity,
                       maxHeight: .infinity)
        }
        // Force the split view to claim all available vertical space
        // in the detail pane — without this it sizes to its content's
        // intrinsic height and gets vertically centered, which leaves
        // a giant gap below the breadcrumb header.
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var sidebar: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundColor(.secondary)
                TextField("Search…", text: $search)
                    .textFieldStyle(.roundedBorder)
                Picker("", selection: $filter) {
                    Text("All").tag(HistoryFilter.all)
                    Text("Edited").tag(HistoryFilter.edited)
                    Text("Not pasted").tag(HistoryFilter.notPasted)
                    Text("With audio").tag(HistoryFilter.withAudio)
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(width: 120)
            }
            .padding(8)

            Divider()

            List(history.filter(search: search, filter: filter), selection: $selection) { entry in
                HistoryRow(entry: entry).tag(entry.id)
            }
            .listStyle(.inset)
        }
    }

    @ViewBuilder
    private var detail: some View {
        if let id = selection, let entry = history.entries.first(where: { $0.id == id }) {
            DetailView(entry: entry)
                .id(id)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            // Frame the empty state to fill the detail column so the
            // `ContentUnavailableView`'s built-in centering actually
            // centers — without an explicit fill it lays out at its
            // intrinsic size and floats to one edge of the splitter
            // cell.
            ContentUnavailableView("Nothing selected", systemImage: "text.bubble",
                                   description: Text("Choose a transcription on the left."))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

private struct HistoryRow: View {
    let entry: TranscriptionEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if entry.editedAt != nil {
                    Image(systemName: "pencil.circle.fill")
                        .foregroundColor(.speakistPeach)
                        .imageScale(.small)
                }
                if entry.pasteStatus != "pasted" {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(.speakistMustard)
                        .imageScale(.small)
                }
                if entry.audioPath != nil {
                    Image(systemName: "waveform")
                        .foregroundColor(.secondary)
                        .imageScale(.small)
                }
                Text(shortDate(entry.createdAt))
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Text(previewLine).lineLimit(2)
                .font(.callout)
        }
        .padding(.vertical, 4)
    }

    private var previewLine: String {
        let source = entry.finalTranscript.isEmpty ? entry.rawTranscript : entry.finalTranscript
        return source.isEmpty ? "— empty —" : source
    }

    private func shortDate(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateStyle = .short
        f.timeStyle = .short
        return f.string(from: date)
    }
}

private struct DetailView: View {
    @EnvironmentObject var env: AppEnvironment
    @EnvironmentObject var history: HistoryStore
    @EnvironmentObject var correctionStore: CorrectionStore
    @State var entry: TranscriptionEntry

    @State private var finalDraft: String = ""
    @State private var showingDeleteConfirm = false
    @State private var player: AVAudioPlayer?
    @State private var isPlayingAudio = false
    /// Drives the save-on-blur behavior for the Final transcript
    /// TextEditor below. SwiftUI fires our `.onChange(of:)` whenever
    /// the editor gains or loses key focus; we save on the
    /// false-transition. Without this the user had to navigate to a
    /// different history row before edits committed.
    @FocusState private var finalDraftFocused: Bool

    init(entry: TranscriptionEntry) {
        self._entry = State(initialValue: entry)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(fullDate(entry.createdAt))
                            .font(.headline)
                        Text(metaLine)
                            .font(.footnote).foregroundColor(.secondary)
                    }
                    Spacer()
                    HStack(spacing: 8) {
                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(finalDraft, forType: .string)
                        } label: { Label("Copy", systemImage: "doc.on.doc") }
                            .labelStyle(.iconOnly)
                            .help("Copy transcript")

                        if entry.audioPath != nil {
                            Button {
                                Task { await env.transcriptionService.retranscribe(entryID: entry.id) }
                            } label: { Label("Re-transcribe", systemImage: "arrow.clockwise") }
                                .labelStyle(.iconOnly)
                                .help("Re-transcribe from saved audio")
                        }
                        Button(role: .destructive) {
                            showingDeleteConfirm = true
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                        .labelStyle(.iconOnly)
                        .help("Delete this entry")
                    }
                }

                GroupBox("Raw transcript") {
                    Text(entry.rawTranscript.isEmpty ? "(empty)" : entry.rawTranscript)
                        .font(.system(.callout, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }

                GroupBox("Final transcript (edits are saved on blur)") {
                    TextEditor(text: $finalDraft)
                        .font(.callout)
                        .frame(minHeight: 160)
                        .focused($finalDraftFocused)
                        .onAppear { finalDraft = entry.finalTranscript }
                        // Save when the editor loses focus — this makes
                        // the GroupBox label literally true. Belt + the
                        // the `.onDisappear` below.
                        .onChange(of: finalDraftFocused) { _, focused in
                            if !focused { saveEditsIfChanged() }
                        }
                }

                if let path = entry.audioPath {
                    GroupBox("Audio") {
                        HStack {
                            Button {
                                toggleAudio(path: path)
                            } label: {
                                Label(isPlayingAudio ? "Pause" : "Play",
                                      systemImage: isPlayingAudio ? "pause.fill" : "play.fill")
                            }
                            Text(path).font(.footnote).foregroundColor(.secondary).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Button("Show in Finder") {
                                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
                            }
                        }
                    }
                }

                if let err = entry.errorMessage {
                    Text("Error: \(err)")
                        .font(.footnote)
                        .foregroundColor(.red)
                }
            }
            .padding()
        }
        .onDisappear { saveEditsIfChanged() }
        .confirmationDialog("Delete this transcription?", isPresented: $showingDeleteConfirm, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                history.delete(id: entry.id)
            }
        }
        .onSubmit { saveEditsIfChanged() }
        .background(
            // Save on focus loss via a dummy TextField workaround: save when the view leaves window focus.
            Color.clear
        )
    }

    private var metaLine: String {
        var parts: [String] = []
        parts.append("On this Mac")
        parts.append(String(format: "%.1fs", Double(entry.durationMs) / 1000.0))
        parts.append(entry.pasteStatus)
        if let bundle = entry.targetBundleID { parts.append(bundle) }
        return parts.joined(separator: " • ")
    }

    private func fullDate(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .medium
        return f.string(from: date)
    }

    private func saveEditsIfChanged() {
        guard finalDraft != entry.finalTranscript else { return }
        // Learn only what the user changed in History. Comparing against raw
        // ASR would mistakenly teach automatic cleanup and replacements as
        // new vocabulary rules.
        let pairs = DiffEngine.corrections(from: entry.finalTranscript, to: finalDraft)
        correctionStore.ingest(pairs: pairs)
        history.updateFinalTranscript(id: entry.id, newText: finalDraft)
        entry.finalTranscript = finalDraft
        entry.editedAt = Date()
    }

    private func toggleAudio(path: String) {
        if isPlayingAudio {
            player?.pause()
            isPlayingAudio = false
            return
        }
        do {
            if player == nil {
                player = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: path))
            }
            player?.play()
            isPlayingAudio = true
        } catch {
            Logger.shared.warn("audio play failed: \(error.localizedDescription)")
        }
    }
}
