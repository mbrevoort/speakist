import Foundation
import AppKit
import Carbon.HIToolbox

enum PasteOutcome: Equatable {
    case pasted
    case clipboardOnly
    case failed(String)
}

@MainActor
final class CursorInserter {

    /// Clipboard + synthetic ⌘V paste, with clipboard restore on completion.
    ///
    /// `hasEditableFocus` is the FocusedFieldProbe's best guess based on
    /// AX role / value-settable / selected-text-attribute heuristics. It
    /// reliably says `true` for native AppKit text fields and views; it
    /// often says `false` for custom-renderer apps (Ghostty, Warp, some
    /// Electron apps, anything that doesn't expose standard AX text
    /// roles for its input area). Originally we treated `false` as a
    /// hard "skip the paste" signal — that broke pasting into Claude
    /// Code running inside Ghostty/Warp because their terminal views
    /// don't advertise AXTextArea.
    ///
    /// Now we treat `false` as just a hint: still attempt the synthetic
    /// ⌘V if AX is trusted. Worst case the paste lands somewhere
    /// unexpected (the user just deliberately invoked Speakist, so they
    /// were focused on a target) and the clipboard contents are still
    /// available for a manual ⌘V. Best case the paste actually works
    /// in the apps the heuristic mis-classifies.
    func insert(text: String, hasEditableFocus: Bool, bundleID: String?) async -> PasteOutcome {
        guard !text.isEmpty else { return .failed("Empty transcript") }

        let pasteboard = NSPasteboard.general
        let snapshot = Self.snapshot(pasteboard: pasteboard)
        let snapshotChangeCount = pasteboard.changeCount

        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)

        // Hard requirement: without AX trust we can't synthesize key
        // events. Surface as clipboard-only so the user knows to ⌘V.
        guard AXIsProcessTrusted() else {
            Logger.shared.info("paste skipped (AX not trusted) bundle=\(bundleID ?? "?") hasEditableFocus=\(hasEditableFocus)")
            return .clipboardOnly
        }

        Logger.shared.info("paste attempt bundle=\(bundleID ?? "?") hasEditableFocus=\(hasEditableFocus)")
        Self.postCommandV()

        // Restore the snapshot in a detached task on a longer delay
        // instead of awaiting inline. The previous 120ms inline await
        // raced the target app's event loop in apps that batch
        // keystrokes through a non-AppKit input pipeline (Electron
        // hosts: Slack, Discord, VS Code; terminal hosts: Ghostty,
        // Warp; Tauri/web-bridge apps). Their queued ⌘V wouldn't get
        // serviced for ~200-400ms after `CGEvent.post` returns —
        // by which point we'd already restored, and they'd then
        // paste the *restored* old clipboard. User-visible bug:
        // transcription pastes the previous clipboard contents.
        //
        // Detaching means the rest of the transcription pipeline
        // (history write, success notifier) doesn't block on the
        // restore window either. The user's clipboard is "wrong"
        // for ~500ms post-paste; same brief window every other
        // paste-and-restore utility has, including macOS's own
        // Universal Clipboard hand-off.
        Self.scheduleClipboardRestore(
            snapshot: snapshot,
            expectedChangeCount: snapshotChangeCount + 1,
            on: pasteboard
        )

        // Reflect uncertainty: if the focus probe couldn't confirm an
        // editable target, label the outcome `clipboardOnly` even
        // though we attempted a paste. The notifier won't show a
        // success toast for those cases — better than falsely
        // claiming success in apps where the probe is consistently
        // wrong.
        return hasEditableFocus ? .pasted : .clipboardOnly
    }

    /// Restore the previous pasteboard contents after enough time
    /// has passed for the target app to consume our synthesized ⌘V.
    /// 500ms covers the slow-consumer apps observed in practice
    /// (Electron, terminal hosts) with margin; on a fast native
    /// AppKit app the user's clipboard is "wrong" for half a second
    /// they're not looking at. The if-changeCount-still-matches
    /// guard skips restore when the user (or another app) wrote to
    /// the pasteboard during the window — preserves whatever the
    /// most recent thing they copied was.
    private static func scheduleClipboardRestore(
        snapshot: ClipboardSnapshot,
        expectedChangeCount: Int,
        on pasteboard: NSPasteboard
    ) {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard pasteboard.changeCount == expectedChangeCount else {
                Logger.shared.info("paste restore skipped: pasteboard changed during paste window")
                return
            }
            restore(snapshot: snapshot, on: pasteboard)
        }
    }

    // MARK: - Clipboard snapshot / restore

    private struct ClipboardSnapshot {
        let items: [[NSPasteboard.PasteboardType: Data]]
    }

    private static func snapshot(pasteboard: NSPasteboard) -> ClipboardSnapshot {
        guard let items = pasteboard.pasteboardItems else { return ClipboardSnapshot(items: []) }
        let snaps: [[NSPasteboard.PasteboardType: Data]] = items.map { item in
            var map: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) {
                    map[type] = data
                }
            }
            return map
        }
        return ClipboardSnapshot(items: snaps)
    }

    private static func restore(snapshot: ClipboardSnapshot, on pasteboard: NSPasteboard) {
        pasteboard.clearContents()
        guard !snapshot.items.isEmpty else { return }
        let newItems: [NSPasteboardItem] = snapshot.items.map { map in
            let item = NSPasteboardItem()
            for (type, data) in map {
                item.setData(data, forType: type)
            }
            return item
        }
        pasteboard.writeObjects(newItems)
    }

    // MARK: - Synthetic Cmd+V

    /// Post a ⌘V key sequence via Quartz. Synthesizes ONLY the V key-
    /// down and key-up events with the `.maskCommand` flag set —
    /// dropping the previous separate cmd-down / cmd-up events.
    ///
    /// Why the simpler pattern: with explicit cmd-down / cmd-up
    /// events, some apps (notably terminal hosts like Ghostty and
    /// Warp that read input via raw keystroke pipelines) saw the
    /// cmd-down without `.maskCommand` on the same event and
    /// interpreted the modifier state as inconsistent — the ⌘V then
    /// arrived as a plain "v" or got dropped entirely. Setting the
    /// flag on the V event itself is what every other production
    /// paste utility (Raycast, BetterTouchTool, KeyboardCowboy)
    /// does, and it works in all the apps that previously worked
    /// with the longer pattern.
    private static func postCommandV() {
        let source = CGEventSource(stateID: .combinedSessionState)
        let vKey: CGKeyCode = 9 // "v"

        let vDown = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: true)
        vDown?.flags = .maskCommand
        let vUp = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: false)
        vUp?.flags = .maskCommand

        let tap = CGEventTapLocation.cghidEventTap
        vDown?.post(tap: tap)
        vUp?.post(tap: tap)
    }
}
