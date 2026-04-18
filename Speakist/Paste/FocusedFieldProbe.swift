import Foundation
import AppKit
import ApplicationServices

/// Inspects the system-focused UI element via the Accessibility API to decide
/// whether a synthetic paste is likely to land in a real text input.
@MainActor
final class FocusedFieldProbe {
    struct Result {
        let hasEditableFocus: Bool
        let bundleID: String?
    }

    func probe() -> Result {
        let bundleID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        guard AXIsProcessTrusted() else {
            return Result(hasEditableFocus: false, bundleID: bundleID)
        }

        let systemWide = AXUIElementCreateSystemWide()
        var focused: CFTypeRef?
        let axStatus = AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute as CFString, &focused)
        guard axStatus == .success, let focusedElement = focused else {
            return Result(hasEditableFocus: false, bundleID: bundleID)
        }
        let element = focusedElement as! AXUIElement

        // Role-based heuristic: common editable roles.
        var role: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
        let roleString = (role as? String) ?? ""
        let editableRoles: Set<String> = [
            kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole
        ]
        if editableRoles.contains(roleString) {
            return Result(hasEditableFocus: true, bundleID: bundleID)
        }

        // Subrole check for secure fields / search fields.
        var subrole: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subrole)
        let subroleString = (subrole as? String) ?? ""
        if subroleString == kAXSecureTextFieldSubrole || subroleString == kAXSearchFieldSubrole {
            return Result(hasEditableFocus: true, bundleID: bundleID)
        }

        // kAXValueAttribute that's a String is usually editable; covers web text fields too.
        var value: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value)
        if value is String {
            // Check writability to weed out read-only labels.
            var settable: DarwinBoolean = false
            AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
            if settable.boolValue {
                return Result(hasEditableFocus: true, bundleID: bundleID)
            }
        }

        // kAXSelectedTextAttribute presence usually indicates a text view.
        var selectedText: CFTypeRef?
        let selStatus = AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute as CFString, &selectedText)
        if selStatus == .success {
            return Result(hasEditableFocus: true, bundleID: bundleID)
        }

        return Result(hasEditableFocus: false, bundleID: bundleID)
    }
}
