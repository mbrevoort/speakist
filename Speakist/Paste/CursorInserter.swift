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

        // Give the target app a beat to process the paste before
        // restoring the clipboard.
        try? await Task.sleep(nanoseconds: 120_000_000)

        // If the user copied something in the meantime, leave it alone.
        if pasteboard.changeCount == snapshotChangeCount + 1 {
            Self.restore(snapshot: snapshot, on: pasteboard)
        }

        // Reflect uncertainty: if the focus probe couldn't confirm an
        // editable target, label the outcome `clipboardOnly` even
        // though we attempted a paste. The notifier won't show a
        // success toast for those cases — better than falsely
        // claiming success in apps where the probe is consistently
        // wrong.
        return hasEditableFocus ? .pasted : .clipboardOnly
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
