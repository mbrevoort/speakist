import SwiftUI
import AppKit

/// Click-or-copy URL row used by the Mac sign-in panels (Settings
/// account tab + Onboarding sign-in step). Renders the verification
/// URL as a clickable link with a Copy button right next to it.
///
/// Why both clickable AND copyable: the Mac auto-launches whichever
/// browser is system default, but on a multi-browser / multi-profile
/// machine that's rarely the profile the user actually wants to sign
/// in from. Click handles the simple case; Copy lets the user paste
/// into any browser/profile they want.
///
/// Used by SettingsWindow and OnboardingWindow — kept as a single
/// shared component so the two surfaces stay visually + behaviorally
/// identical without duplication drift.
struct SignInURLRow: View {
    let url: URL

    var body: some View {
        HStack(spacing: 8) {
            Link(destination: url) {
                Text(url.absoluteString)
                    .font(.system(size: 12, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .help("Open in default browser")
            Spacer(minLength: 8)
            Button {
                let pb = NSPasteboard.general
                pb.clearContents()
                pb.setString(url.absoluteString, forType: .string)
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color(NSColor.textBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color(NSColor.separatorColor), lineWidth: 0.5)
        )
    }
}
