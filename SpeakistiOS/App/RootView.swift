import SwiftUI

/// Top-level iOS view. Picks one of three main states:
///
///   1. **Onboarding** — first-launch flow that walks the user through
///      sign-in, mic permission, enabling the custom keyboard in Settings,
///      and granting Full Access.
///   2. **Listening overlay** — a full-screen purple card shown while a
///      Speak Session is active. This is the "iOS now requires this to
///      activate the microphone" moment Wispr Flow pioneered; our version
///      teaches the swipe-right gesture, then stays out of the way.
///   3. **Home** — the main in-app surface: usage, settings, history,
///      account. Boring but necessary.
struct RootView: View {
    @EnvironmentObject private var session: SpeakSessionController
    @AppStorage("onboardingCompleted") private var onboardingCompleted: Bool = false

    var body: some View {
        ZStack {
            if !onboardingCompleted {
                OnboardingFlow(onComplete: { onboardingCompleted = true })
            } else {
                HomeView()
            }

            if session.isActivatingOrListening {
                ListeningOverlay()
                    .transition(.opacity)
                    .zIndex(10)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: session.isActivatingOrListening)
        .tint(.speakistPeach)
    }
}

/// Placeholder home view. Real implementation will include: usage
/// dashboard, polish prefs, tone presets, session history. Kept minimal
/// for the scaffold so the rest of the plumbing can be wired and tested
/// first. Account state lives at the top so the user can always tell
/// whether they're signed in without hunting through screens.
struct HomeView: View {
    @EnvironmentObject private var session: SpeakSessionController
    @EnvironmentObject private var account: SpeakistAccountManager
    @EnvironmentObject private var history: HistoryStore
    @State private var quickDictatePresented = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    QuickDictateCTA(isSignedIn: account.isSignedIn) {
                        quickDictatePresented = true
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }

                Section("Account") {
                    AccountRow()
                    if account.isSignedIn {
                        DashboardLink()
                    }
                }

                // Polish controls render inline (toggle + mode picker
                // when signed in). The PolishSection view returns
                // EmptyView() when signed out so it disappears entirely
                // — no NavigationLink, no detail screen.
                PolishSection()

                Section {
                    NavigationLink {
                        HistoryView()
                    } label: {
                        HStack {
                            Label("History", systemImage: "clock.arrow.circlepath")
                            Spacer()
                            if !history.entries.isEmpty {
                                Text("\(history.entries.count)")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: {
                    Text("Dictations")
                } footer: {
                    // Storage location is privacy-relevant — call it out so
                    // users don't assume their transcripts are sitting in
                    // some cloud account they can't see. The HistoryStore
                    // writes to the App Group container on this device only;
                    // nothing about the transcript text leaves the phone
                    // after the transcribe API returns it.
                    Text("Saved on this device only — never uploaded.")
                }

                Section("Status") {
                    HStack {
                        Text("Session")
                        Spacer()
                        Text(session.status.rawValue.capitalized)
                            .foregroundStyle(.secondary)
                    }
                    HStack {
                        Text("Channel")
                        Spacer()
                        Text(SpeakistChannel.current.displayLabel)
                            .foregroundStyle(.secondary)
                    }
                    HStack {
                        Text("Build")
                        Spacer()
                        Text(buildStampLabel)
                            .foregroundStyle(.secondary)
                            .font(.footnote.monospacedDigit())
                    }
                }

                Section("Keyboard") {
                    Button("Open iOS Keyboard Settings") {
                        KeyboardSettingsHelper.openKeyboardSettings()
                    }
                    Text("Enable Speakist Keyboard, then toggle **Allow Full Access** so it can reach the mic session.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                // Danger zone — intentionally last, behind a scroll.
                // Only signed-in users have an account to delete; for
                // signed-out users the section is hidden entirely so
                // the home screen's "below the fold" stays empty
                // rather than offering a destructive action with no
                // target.
                if account.isSignedIn {
                    DangerZoneSection()
                }
            }
            .navigationTitle("Speakist")
            .sheet(isPresented: $quickDictatePresented) {
                QuickDictateView(
                    history: history,
                    tokenProvider: { [weak account] in account?.bearerToken }
                )
            }
        }
    }
}

/// "2026-04-23 11:57 UTC"-style label from the `SpeakistBuildTimestamp`
/// Info.plist key (stamped by `preBuildScripts` in project.yml on every
/// rebuild). Lets you glance at the Home view and confirm the app on
/// your phone is the build you just deployed, instead of guessing
/// whether iOS has cached a stale bundle.
private var buildStampLabel: String {
    guard let raw = Bundle.main.object(forInfoDictionaryKey: "SpeakistBuildTimestamp") as? String,
          raw != "0" else {
        return "unknown"
    }
    let parser = ISO8601DateFormatter()
    guard let date = parser.date(from: raw) else { return raw }
    let fmt = DateFormatter()
    fmt.dateFormat = "MMM d, HH:mm"
    return fmt.string(from: date) + " UTC"
}

/// Primary home-screen CTA that launches Quick Dictate. Full-bleed
/// peach card sized like a feature row — big enough to feel like the
/// main thing on this screen, which matches its priority in the UX
/// (the keyboard is the *eventual* destination but most users will try
/// Quick Dictate first because it's immediate).
private struct QuickDictateCTA: View {
    let isSignedIn: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 16) {
                ZStack {
                    Circle()
                        .fill(.white.opacity(0.22))
                        .frame(width: 56, height: 56)
                    Image(systemName: "waveform.badge.mic")
                        .font(.system(size: 26, weight: .semibold))
                        .foregroundStyle(.white)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Quick Dictate")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.white)
                    Text(isSignedIn
                         ? "Speak now — we'll copy the result to your clipboard."
                         : "Sign in to unlock Quick Dictate.")
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.85))
                        .multilineTextAlignment(.leading)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.7))
            }
            .padding(16)
            .frame(maxWidth: .infinity)
            .background(
                LinearGradient(
                    colors: [.speakistPeach, Color.speakistPeach.opacity(0.85)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .opacity(isSignedIn ? 1 : 0.55)
        }
        .buttonStyle(.plain)
        .disabled(!isSignedIn)
        .padding(.horizontal)
        .padding(.vertical, 8)
    }
}

/// External-link row that opens the web dashboard in Safari (or the
/// in-app SFSafariViewController, but UIApplication.open keeps things
/// simple — Safari already has the user's session cookie if they signed
/// in via the device-code flow). URL is channel-aware so dev builds open
/// `speakist-dev.brevoortstudio.com`, stable builds open `speakist.ai`.
private struct DashboardLink: View {
    var body: some View {
        Button {
            let base = SpeakistChannel.current.defaultAPIBaseURL
            if let url = URL(string: "/dashboard", relativeTo: base) {
                UIApplication.shared.open(url)
            }
        } label: {
            HStack {
                Label("Open Dashboard", systemImage: "safari")
                Spacer()
                Image(systemName: "arrow.up.right.square")
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// Account row in Settings/Home. Renders one of three states:
///
///   * signed-out → "Not signed in" + prominent Sign in button
///   * signing-in → the 6-char device code + Reopen browser
///   * signed-in  → email (or fallback), org name if known, balance if
///     known, and a Sign out button
///
/// Kept as its own view so it can be reused from Settings later. Reads
/// the AccountManager from the environment — observation of its
/// `@Published state` is automatic.
private struct AccountRow: View {
    @EnvironmentObject private var account: SpeakistAccountManager

    var body: some View {
        switch account.state {
        case .signedOut:
            signedOut
        case .signingIn(let userCode, let url, _):
            signingIn(userCode: userCode, url: url)
        case .signedIn(let identity):
            signedIn(identity: identity)
        }
    }

    private var signedOut: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Not signed in", systemImage: "person.crop.circle.badge.exclamationmark")
                .foregroundStyle(.secondary)
            Button {
                Task { await account.startSignIn() }
            } label: {
                Text("Sign in")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.speakistPeach)
            if let err = account.lastError {
                Text(err)
                    .font(.footnote)
                    .foregroundStyle(.speakistCoral)
            }
        }
        .padding(.vertical, 4)
    }

    private func signingIn(userCode: String, url: URL) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Approve in your browser", systemImage: "hourglass")
                .foregroundStyle(.speakistPeach)
            Text("Confirm this code matches the one on the approval page:")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Text(userCode)
                .font(.system(size: 28, weight: .bold, design: .monospaced))
                .tracking(6)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            HStack {
                Button("Reopen browser") {
                    UIApplication.shared.open(url)
                }
                .buttonStyle(.bordered)
                Spacer()
                Button("Cancel", role: .destructive) {
                    account.signOut()
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 4)
    }

    private func signedIn(identity: SpeakistAccountManager.Identity?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "checkmark.seal.fill")
                    .foregroundStyle(.speakistSage)
                    .font(.title2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(identity?.displayName ?? identity?.email ?? "Signed in")
                        .font(.body.weight(.medium))
                    if let email = identity?.email, email != identity?.displayName {
                        Text(email)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if let org = identity?.orgName {
                HStack {
                    Text("Workspace")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(org)
                }
                .font(.footnote)
                // Each user belongs to exactly one workspace at a time.
                // Switch by leaving from the web dashboard's settings
                // page, then accepting an invitation or creating a new
                // workspace on next sign-in.
            }

            if let balance = identity?.balanceMillicents {
                HStack {
                    Text("Balance")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(formatBalance(millicents: balance))
                }
                .font(.footnote)
            }

            Button(role: .destructive) {
                account.signOut()
            } label: {
                Text("Sign out")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
        .padding(.vertical, 4)
    }

    private func formatBalance(millicents: Int) -> String {
        // millicents → dollars. Mirrors the Mac app's credit ledger: the
        // backend stores balances in thousandths of a cent (millicents)
        // for sub-cent precision; we render dollars-and-cents for humans.
        let dollars = Double(millicents) / 100_000.0
        return String(format: "$%.2f", dollars)
    }
}

/// Standalone "Danger Zone" section pinned to the bottom of the home
/// list. Account deletion has its own row, its own header, and its
/// own footer so the user has to *scroll past everything else* to
/// reach it — the visual treatment signals "this is the irreversible
/// option, not a setting you tweak idly".
///
/// Required by App Review 5.1.1(v): account deletion must be
/// reachable from inside the app, not delegated to a web link. The
/// destructive alert + spinner-blocked retry are unchanged from the
/// previous inline implementation; only the location moved.
private struct DangerZoneSection: View {
    @EnvironmentObject private var account: SpeakistAccountManager

    /// Native confirm alert — second gesture before the network call.
    @State private var showingDeleteConfirm = false
    /// Server-side deletion is one round-trip; the spinner blocks
    /// double-tap during the in-flight request.
    @State private var deleting = false
    /// Surfaces a server failure inline. Cleared on next attempt.
    @State private var deleteError: String?

    var body: some View {
        Section {
            Button {
                deleteError = nil
                showingDeleteConfirm = true
            } label: {
                if deleting {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text("Deleting…")
                    }
                    .frame(maxWidth: .infinity)
                } else {
                    Text("Delete Account")
                        .frame(maxWidth: .infinity)
                        .foregroundStyle(.speakistCoral)
                        .fontWeight(.medium)
                }
            }
            .disabled(deleting)
            .alert("Delete your Speakist account?", isPresented: $showingDeleteConfirm) {
                Button("Cancel", role: .cancel) {}
                Button("Delete", role: .destructive) {
                    Task { await performDeleteAccount() }
                }
            } message: {
                // Spell out the scope so users understand what
                // "delete" includes — most assume it's just the
                // email-and-password, not the credit balance and
                // dictation history.
                Text("This permanently deletes your account, balance, vocabulary, and dictation history, and signs you out everywhere. This cannot be undone.")
            }

            if let err = deleteError {
                Text(err)
                    .font(.footnote)
                    .foregroundStyle(.speakistCoral)
            }
        } header: {
            Text("Danger Zone")
        } footer: {
            Text("Permanently removes your account, balance, vocabulary, and dictation history. There's no undo.")
        }
    }

    private func performDeleteAccount() async {
        deleting = true
        deleteError = nil
        defer { deleting = false }
        do {
            try await account.deleteAccount()
            // Account is gone server-side and the manager already
            // flipped state to .signedOut — the parent view reacts
            // via @EnvironmentObject, no extra UI work needed here.
            // The HomeView re-renders without this section because
            // `account.isSignedIn` is now false.
        } catch {
            // Surface the message inline rather than throwing the
            // user back to a sign-in flow with no context. The
            // server route is idempotent enough that a retry after
            // partial failure is safe.
            if let api = error as? SpeakistAPIClient.Error {
                deleteError = api.description
            } else {
                deleteError = error.localizedDescription
            }
        }
    }
}
