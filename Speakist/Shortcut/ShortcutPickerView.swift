import SwiftUI
import AppKit
import KeyboardShortcuts

// Shared push-to-talk shortcut picker used by Onboarding's
// "Set your shortcut" pane and Settings → Shortcuts. Renders two
// side-by-side pills (Globe vs. a custom key combo) plus a
// matching info callout when Globe is the active choice.
//
// Both surfaces share this view so the interaction is identical
// regardless of where the user encounters it for the first time
// (during onboarding) vs. where they tweak it later (Settings).
// The visual chrome around the pills (Form section, card
// background, etc.) is the caller's job — this just owns the
// behavior inside the row.

/// The two-pill row: Globe and the custom-shortcut option. Click
/// either to make it the active push-to-talk binding. The selected
/// pill picks up a peach border + tinted fill so the active choice
/// is unambiguous; the unselected one is muted gray.
///
/// **Why we don't use the KeyboardShortcuts.Recorder in both
/// states:** the Recorder is an NSViewRepresentable that consumes
/// clicks for its own recording UI, so wrapping it in a SwiftUI
/// gesture to flip the toggle doesn't work — the click never
/// reaches SwiftUI's gesture system. When this pill isn't the
/// selected option we render a plain SwiftUI Button showing the
/// shortcut as static text; the Button reliably receives the
/// click and flips `useGlobeKey` to false. Once selected, we swap
/// in the real Recorder so a second click can record a new combo.
struct ShortcutPickerPills: View {
    @EnvironmentObject var prefs: Preferences

    var body: some View {
        HStack(spacing: 8) {
            globePill
            customRecorderPill
        }
    }

    private var globePill: some View {
        Button {
            prefs.useGlobeKey = true
        } label: {
            Text("🌐 Globe (fn)")
                .font(.system(.body, design: .monospaced))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(prefs.useGlobeKey
                              ? Color.speakistPeach.opacity(0.25)
                              : Color.secondary.opacity(0.12))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(
                            prefs.useGlobeKey ? Color.speakistPeach : .clear,
                            lineWidth: 1.5
                        )
                )
        }
        .buttonStyle(.plain)
    }

    /// Custom-shortcut pill. Renders a plain SwiftUI Button when
    /// Globe is the active choice (so clicks reliably switch
    /// modes), and the real KeyboardShortcuts.Recorder once this
    /// is selected (so the user can record a new combo).
    private var customRecorderPill: some View {
        Group {
            if prefs.useGlobeKey {
                Button {
                    prefs.useGlobeKey = false
                } label: {
                    Text(currentShortcutDisplay)
                        .font(.system(.body, design: .monospaced))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(
                            RoundedRectangle(cornerRadius: 6)
                                .fill(Color.secondary.opacity(0.12))
                        )
                }
                .buttonStyle(.plain)
            } else {
                KeyboardShortcuts.Recorder(for: .pushToTalk)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .strokeBorder(Color.speakistPeach, lineWidth: 1.5)
                            .allowsHitTesting(false)
                    )
            }
        }
    }

    /// Human-readable form of the current push-to-talk shortcut
    /// (e.g. "⌃⌘X"). Em-dash placeholder if the user has cleared
    /// the binding entirely.
    private var currentShortcutDisplay: String {
        KeyboardShortcuts.getShortcut(for: .pushToTalk)?.description ?? "—"
    }
}

/// The mustard "one quick macOS setting" callout shown only when
/// Globe is the active binding. Surfaces the System Settings →
/// Keyboard → "Press 🌐 key to" → "Do Nothing" step that's needed
/// for the OS to release the key to our event monitor, with a
/// button that jumps straight to Keyboard settings.
///
/// `frame(maxWidth: .infinity, alignment: .leading)` stretches the
/// background to whatever container is rendering it, so the
/// callout always matches the width of the surrounding card / row.
struct ShortcutGlobeCallout: View {
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "info.circle.fill")
                .foregroundColor(.speakistMustard)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                Text("One quick macOS setting")
                    .font(.callout.weight(.semibold))
                Text("So macOS doesn't grab the Globe key first: open Keyboard settings and set \u{201C}Press 🌐 key to\u{201D} to \u{201C}Do Nothing\u{201D}.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("This only changes how the Globe key behaves on its own — fn-shortcuts like fn-F2 still work.")
                    .font(.footnote)
                    .foregroundColor(.secondary.opacity(0.8))
                    .fixedSize(horizontal: false, vertical: true)
                Button("Open Keyboard Settings") {
                    Self.openKeyboardSettings()
                }
                .buttonStyle(.link)
                .font(.footnote)
                .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.speakistMustard.opacity(0.10)))
    }

    /// Open System Settings → Keyboard. Tries the modern Ventura+
    /// scheme first, falls back to the legacy preference pane URL.
    /// Either lands the user on the Keyboard pane where the
    /// "Press 🌐 key to" picker lives near the top.
    private static func openKeyboardSettings() {
        let modern = URL(string: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension")
        let legacy = URL(string: "x-apple.systempreferences:com.apple.preference.keyboard")
        if let url = modern, NSWorkspace.shared.open(url) { return }
        if let url = legacy { NSWorkspace.shared.open(url) }
    }
}
