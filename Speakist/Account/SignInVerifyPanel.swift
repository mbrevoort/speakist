import SwiftUI
import AppKit

/// Sign-in verify panel shown while the device-code flow is mid-flight
/// (state == .signingIn). Renders the verification URL and the user
/// code as **separately copyable** items, with click-to-open on the URL.
///
/// Why both copyable AND clickable: developers and power users often
/// run multiple browsers (Chrome, Safari, Arc) with several signed-in
/// profiles each. `NSWorkspace.shared.open(url)` lands in whichever
/// app is "default", which is rarely the *profile* the user wants
/// to sign in from. A copy button means they paste the link into the
/// browser-window-with-the-right-account-already-signed-in. A click
/// is still there for the simple case.
///
/// Layout: URL row (link + copy) above code row (mono + copy), each
/// big enough that comparing the on-screen code against the one the
/// browser shows after the click-through is trivial.
///
/// Used by both `SettingsWindow` (when signed-out users hit Sign in
/// from the Account tab) and `OnboardingWindow` (the sign-in step in
/// the new-install onboarding flow). Single component so the two
/// surfaces stay visually + behaviorally identical.
struct SignInVerifyPanel: View {
    let code: String
    let url: URL
    let expiresAt: Date
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Finish signing in")
                .font(.headline)
            Text("Open this link in the browser and profile you want to sign in with — clicking opens your default browser, or copy and paste it where you want.")
                .font(.footnote)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            // URL row: full URL is clickable + copyable. The Link
            // styling SwiftUI gives is the platform-standard "blue
            // underlined when hovered" — looks like a link out of
            // the box.
            VStack(alignment: .leading, spacing: 4) {
                Text("Verification link")
                    .font(.caption)
                    .foregroundColor(.secondary)
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

            // Code row: same shape, monospaced + tracked so the
            // browser-side display can be compared at a glance.
            VStack(alignment: .leading, spacing: 4) {
                Text("Verification code")
                    .font(.caption)
                    .foregroundColor(.secondary)
                HStack(spacing: 8) {
                    Text(code)
                        .font(.system(size: 18, weight: .semibold, design: .monospaced))
                        .kerning(3)
                        .textSelection(.enabled)
                    Spacer(minLength: 8)
                    Button {
                        let pb = NSPasteboard.general
                        pb.clearContents()
                        pb.setString(code, forType: .string)
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
                Text("This should match the code shown on the verification page.")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            HStack {
                Text("Code expires \(expiresAt.formatted(date: .omitted, time: .shortened))")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
                Button("Cancel", action: onCancel)
            }
        }
        .padding(.vertical, 6)
    }
}
