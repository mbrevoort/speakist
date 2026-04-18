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
    /// If `hasEditableFocus` is false, we leave the transcript on the clipboard and do NOT
    /// restore the old contents — the transcript is the useful payload.
    func insert(text: String, hasEditableFocus: Bool) async -> PasteOutcome {
        guard !text.isEmpty else { return .failed("Empty transcript") }

        let pasteboard = NSPasteboard.general
        let snapshot = Self.snapshot(pasteboard: pasteboard)
        let snapshotChangeCount = pasteboard.changeCount

        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)

        guard hasEditableFocus else {
            return .clipboardOnly
        }

        guard AXIsProcessTrusted() else {
            return .clipboardOnly
        }

        Self.postCommandV()

        // Give the target app a beat to process the paste before restoring the clipboard.
        try? await Task.sleep(nanoseconds: 120_000_000)

        // If the user copied something in the meantime, leave it alone.
        if pasteboard.changeCount == snapshotChangeCount + 1 {
            Self.restore(snapshot: snapshot, on: pasteboard)
        }

        return .pasted
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

    private static func postCommandV() {
        let source = CGEventSource(stateID: .combinedSessionState)
        let vKey: CGKeyCode = 9 // "v"
        let cmdDown = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Command), keyDown: true)
        let vDown = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: true)
        vDown?.flags = .maskCommand
        let vUp = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: false)
        vUp?.flags = .maskCommand
        let cmdUp = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Command), keyDown: false)

        let tap = CGEventTapLocation.cghidEventTap
        cmdDown?.post(tap: tap)
        vDown?.post(tap: tap)
        vUp?.post(tap: tap)
        cmdUp?.post(tap: tap)
    }
}
