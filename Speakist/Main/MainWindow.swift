import AppKit
import SwiftUI

/// Single unified window that hosts Quick Dictate, History, and all the
/// Settings categories under one sidebar. Replaces the old separate
/// `SettingsWindowController` + `HistoryWindowController` so users have
/// one obvious place to land — and so the app has a normal-app surface
/// (Dock + Cmd+Tab + top menu) for the people who can't find the menu
/// bar status item.
@MainActor
final class MainWindowController: NSWindowController, NSWindowDelegate {
    private let env: AppEnvironment
    private let selection: MainSectionStore

    init(env: AppEnvironment) {
        self.env = env
        self.selection = MainSectionStore()

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 980, height: 660),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false)
        window.title = AppIdentity.displayName
        window.minSize = NSSize(width: 820, height: 560)
        window.center()
        window.isReleasedWhenClosed = false
        // Restore size + position across launches so the user's window
        // geometry sticks.
        window.setFrameAutosaveName("SpeakistMainWindow")
        super.init(window: window)
        window.delegate = self

        let root = MainView(selection: selection)
            .environmentObject(env)
            .environmentObject(env.preferences)
            .environmentObject(env.keychain)
            .environmentObject(env.correctionStore)
            .environmentObject(env.usageTracker)
            .environmentObject(env.permissions)
            .environmentObject(env.deviceMonitor)
            .environmentObject(env.accountManager)
            .environmentObject(env.historyStore)
        window.contentView = NSHostingView(rootView: root)
    }

    required init?(coder: NSCoder) { fatalError() }

    /// Show the window. `section` optionally selects which sidebar item
    /// is highlighted on appear — used by the menu bar "Settings…" /
    /// "History…" items so the right pane is already visible.
    func show(section: MainSection? = nil) {
        if let section { selection.current = section }
        NSApp.activate(ignoringOtherApps: true)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }
}

/// Sidebar selection model. Hoisted out of the view so the window
/// controller can pre-select a section before presenting.
@MainActor
final class MainSectionStore: ObservableObject {
    @Published var current: MainSection = .quickDictate
}

/// Sidebar sections. Quick Dictate + History are top-level features;
/// the remaining cases are the granular settings categories migrated
/// from the old standalone Settings window. Each renders a distinct
/// detail view in `MainView`.
enum MainSection: String, CaseIterable, Identifiable, Hashable {
    case quickDictate
    case history
    case account
    case general
    case shortcuts
    case audio
    case transcription
    case polish
    case vocabulary
    case storage
    case about

    var id: String { rawValue }

    var title: String {
        switch self {
        case .quickDictate: return "Quick Dictate"
        case .history: return "History"
        case .account: return "Account"
        case .general: return "General"
        case .shortcuts: return "Shortcuts"
        case .audio: return "Audio"
        case .transcription: return "Transcription"
        case .polish: return "Polish"
        case .vocabulary: return "Vocabulary"
        case .storage: return "Storage"
        case .about: return "About"
        }
    }

    var systemImage: String {
        switch self {
        case .quickDictate: return "mic.circle.fill"
        case .history: return "clock.arrow.circlepath"
        case .account: return "person.crop.circle"
        case .general: return "gear"
        case .shortcuts: return "keyboard"
        case .audio: return "mic"
        case .transcription: return "waveform"
        case .polish: return "sparkles"
        case .vocabulary: return "character.book.closed"
        case .storage: return "externaldrive"
        case .about: return "info.circle"
        }
    }

    /// Which sidebar "group" the row belongs to. Drives the headers in
    /// the sidebar list so Settings categories are visually grouped
    /// below the Quick Dictate / History entries.
    var group: SidebarGroup {
        switch self {
        case .quickDictate, .history: return .workspace
        default: return .settings
        }
    }
}

enum SidebarGroup: String, CaseIterable, Identifiable {
    case workspace
    case settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .workspace: return "Workspace"
        case .settings: return "Settings"
        }
    }
}

struct MainView: View {
    @ObservedObject var selection: MainSectionStore
    @EnvironmentObject var env: AppEnvironment

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 210, ideal: 230, max: 280)
        } detail: {
            detailHost
                .frame(minWidth: 560)
        }
        .navigationSplitViewStyle(.balanced)
        .frame(minWidth: 820, minHeight: 560)
        .tint(.speakistPeach)
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            BrandHeader()
                .padding(.horizontal, 12)
                .padding(.top, 14)
                .padding(.bottom, 8)
            Divider()
            List(selection: $selection.current) {
                ForEach(SidebarGroup.allCases) { group in
                    Section(group.title) {
                        ForEach(MainSection.allCases.filter { $0.group == group }) { section in
                            NavigationLink(value: section) {
                                Label(section.title, systemImage: section.systemImage)
                            }
                        }
                    }
                }
            }
            .listStyle(.sidebar)
        }
    }

    @ViewBuilder
    private var detailHost: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("Speakist")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.secondary)
                Text("›")
                    .foregroundColor(.secondary.opacity(0.5))
                Text(selection.current.title)
                    .font(.system(size: 20, weight: .semibold))
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 6)
            Divider()
            detailBody
        }
    }

    @ViewBuilder
    private var detailBody: some View {
        switch selection.current {
        case .quickDictate:
            QuickDictateView()
        case .history:
            HistoryView()
        case .account:      AccountSettingsView()
        case .general:      GeneralSettingsView()
        case .shortcuts:    ShortcutsSettingsView()
        case .audio:        AudioSettingsView()
        case .transcription: TranscriptionSettingsView()
        case .polish:       PolishSettingsView()
        case .vocabulary:   VocabularySettingsView()
        case .storage:      HistorySettingsView()
        case .about:        AboutSettingsView()
        }
    }
}
