import SwiftUI
import AppKit
import AVFoundation

@MainActor
final class HistoryWindowController: NSWindowController, NSWindowDelegate {
    private let env: AppEnvironment

    init(env: AppEnvironment) {
        self.env = env
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 820, height: 540),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered, defer: false)
        window.title = "Speakist — History"
        window.minSize = NSSize(width: 720, height: 480)
        window.center()
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self

        let root = HistoryView()
            .environmentObject(env)
            .environmentObject(env.historyStore)
            .environmentObject(env.preferences)
            .environmentObject(env.correctionStore)
        window.contentView = NSHostingView(rootView: root)
    }

    required init?(coder: NSCoder) { fatalError() }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        showWindow(nil)
    }
}

struct HistoryView: View {
    @EnvironmentObject var env: AppEnvironment
    @EnvironmentObject var history: HistoryStore
    @State private var search = ""
    @State private var filter: HistoryFilter = .all
    @State private var selection: String?

    var body: some View {
        NavigationSplitView {
            sidebar
        } detail: {
            if let id = selection, let entry = history.entries.first(where: { $0.id == id }) {
                DetailView(entry: entry)
                    .id(id)
            } else {
                ContentUnavailableView("Nothing selected", systemImage: "text.bubble",
                                       description: Text("Choose a transcription on the left."))
            }
        }
        .navigationTitle("History")
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
        .frame(minWidth: 300)
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

                        if entry.audioPath != nil {
                            Button {
                                Task { await env.transcriptionService.retranscribe(entryID: entry.id) }
                            } label: { Label("Re-transcribe", systemImage: "arrow.clockwise") }
                        }
                        Button(role: .destructive) {
                            showingDeleteConfirm = true
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
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
                        .onAppear { finalDraft = entry.finalTranscript }
                        .onChange(of: finalDraft) { _, _ in /* saved on blur */ }
                        .focusable()
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
        parts.append(entry.provider + (entry.model.isEmpty ? "" : " \(entry.model)"))
        parts.append(String(format: "%.1fs", Double(entry.durationMs) / 1000.0))
        parts.append(entry.cleanupApplied ? "cleaned" : "raw")
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
        let pairs = DiffEngine.corrections(from: entry.rawTranscript, to: finalDraft)
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
